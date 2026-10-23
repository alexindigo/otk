// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import * as client from "../mod.ts";
import type { StateFactory } from "../state.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const options = [
  { id: "directory", label: "docs/", directory: true },
  { id: "file", label: "README.md" },
  { id: "agent", label: "explore" },
];
const input = (text = "@read") => ({
  input: text,
  caret: text.length,
  mode: "normal" as const,
  connected: true,
  chips: [] as { start?: number; end?: number }[],
});
const trigger = (value: string, caret: number) =>
  value.startsWith("@")
    ? { start: 0, end: caret, query: value.slice(1, caret) }
    : undefined;

Deno.test("completion arbitrates sources in registration order and excludes unavailable modes and inline chips", async () => {
  const calls: string[] = [];
  const owner = client.createPromptCompletion({
    sources: ["first", "second"].map((id) => ({
      trigger,
      options: (token) => {
        calls.push(`${id}:${token.query}`);
        return Promise.resolve(options);
      },
      select: () => {},
    })),
    fail: (error) => {
      throw error;
    },
  });
  try {
    await owner.update(input());
    assertEquals(calls, ["first:read"]);
    assertEquals(owner.state.visible, true);
    assertEquals(owner.state.token, { start: 0, end: 5, query: "read" });
    for (
      const value of [
        { ...input(), connected: false },
        { ...input(), mode: "shell" as const },
        { ...input(), chips: [{ start: 0, end: 5 }] },
        input("plain"),
      ]
    ) {
      await owner.update(value);
      assertEquals(owner.state.visible, false);
      assertEquals(owner.state.options, []);
      assertEquals(owner.state.token, undefined);
    }
    await owner.update({ ...input(), chips: [{}] });
    assertEquals(calls, ["first:read", "first:read"]);
    assertEquals(
      owner.state.visible,
      true,
      "Independent attachments do not block completion",
    );
  } finally {
    owner.dispose();
  }
});

Deno.test("completion only publishes options and failures for its current query lifetime", async () => {
  const requests = Array.from({ length: 5 }, () => deferred<typeof options>());
  let count = 0;
  const failures: unknown[] = [];
  const owner = client.createPromptCompletion({
    sources: [{
      trigger,
      options: () => requests[count++].promise,
      select: () => {},
    }],
    fail: (error) => failures.push(error),
  });
  try {
    const old = owner.update(input("@old"));
    const current = owner.update(input("@current"));
    assertEquals(owner.state.options, []);
    requests[1].resolve(options);
    await current;
    owner.move(1);
    requests[0].resolve([{ id: "stale", label: "Stale" }]);
    await old;
    assertEquals(owner.state.options, options);
    assertEquals(owner.state.choice, 1);
    const closed = owner.update(input("@closed"));
    owner.clear();
    requests[2].resolve(options);
    await closed;
    assertEquals(owner.state.visible, false);
    const staleError = owner.update(input("@stale-error"));
    const liveError = owner.update(input("@live-error"));
    const error = new Error("current source unavailable");
    requests[3].reject(new Error("retired source unavailable"));
    requests[4].reject(error);
    await Promise.all([staleError, liveError]);
    assertEquals(failures, [error]);
    assertStrictEquals(failures[0], error);
    assertEquals(owner.state.visible, false);
  } finally {
    owner.dispose();
  }
});

Deno.test("completion disposal retires pending results and errors and prevents later source effects", async () => {
  for (const reject of [false, true]) {
    const pending = deferred<typeof options>();
    let reads = 0, selects = 0, failures = 0, notices = 0;
    const owner = client.createPromptCompletion({
      sources: [{
        trigger,
        options: () => {
          reads++;
          return pending.promise;
        },
        select: () => selects++,
      }],
      fail: () => failures++,
    });
    const release = owner.subscribe(() => notices++);
    const work = owner.update(input());
    owner.dispose();
    const disposedNotices = notices;
    if (reject) pending.reject(new Error("late error"));
    else pending.resolve(options);
    await work;
    await owner.update(input("@later"));
    owner.move(1);
    owner.choose(0);
    owner.clear();
    owner.dispose();
    assertEquals({ reads, selects, failures, notices }, {
      reads: 1,
      selects: 0,
      failures: 0,
      notices: disposedNotices,
    });
    assertEquals(owner.state.visible, false);
    assertEquals(owner.state.options, []);
    release();
  }
});

Deno.test("completion choice wraps, expands directories and delivers the exact captured token and option", async () => {
  const selected: unknown[] = [];
  const owner = client.createPromptCompletion({
    sources: [{
      trigger,
      options: () => Promise.resolve(options),
      select: (token, option, expand) => selected.push([token, option, expand]),
    }],
    fail: (error) => {
      throw error;
    },
  });
  try {
    owner.move(-1);
    assertEquals(owner.state.choice, 0, "Empty choices never become NaN");
    await owner.update(input());
    owner.move(-1);
    assertEquals(owner.state.choice, 2);
    owner.move(1);
    assertEquals(owner.state.choice, 0);
    const token = owner.state.token;
    owner.choose(0, true);
    assertEquals(owner.state.visible, true);
    owner.choose(100);
    assertEquals(selected.length, 1);
    owner.choose(1, true);
    assertEquals(owner.state.visible, false);
    assertEquals(selected, [[token, options[0], true], [
      token,
      options[1],
      true,
    ]]);
    await owner.update(input());
    assertEquals(owner.state.choice, 0);
    owner.choose(0);
    assertEquals(
      owner.state.visible,
      false,
      "Enter selects rather than expands a directory",
    );
  } finally {
    owner.dispose();
  }
});

Deno.test("completion intents read owner-current state before deferred framework publication", async () => {
  let publish!: () => void, notices = 0;
  const factory: StateFactory = <T extends object>(initial: T) => {
    const queued = structuredClone(initial),
      listeners = new Set<(state: T) => void>();
    publish = () => {
      Object.assign(initial, queued);
      for (const listener of listeners) listener(initial);
    };
    return {
      state: initial,
      update(change: (value: T) => void) {
        change(queued);
      },
      reconcile<V extends object>(target: V, value: V) {
        Object.assign(target, value);
      },
      subscribe(listener: (state: T) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  };
  const selected: string[] = [];
  const owner = client.createPromptCompletion({
    sources: [{
      trigger,
      options: () => Promise.resolve(options),
      select: (_token, option) => selected.push(option.id),
    }],
    factory,
    fail: (error) => {
      throw error;
    },
  });
  const release = owner.subscribe(() => notices++);
  try {
    await owner.update(input());
    owner.move(1);
    owner.move(1);
    owner.choose(owner.state.choice);
    assertEquals(selected, ["agent"]);
    assertEquals(owner.state.visible, false);
    assertEquals(notices, 0);
    publish();
    assertEquals(notices, 1);
  } finally {
    release();
    owner.dispose();
  }
});

Deno.test("completion selection cannot clear a replacement query started by its source callback", async () => {
  let replacement: Promise<void> | undefined;
  const owner = client.createPromptCompletion({
    sources: [{
      trigger,
      options: (token) =>
        Promise.resolve([{ id: token.query, label: token.query }]),
      select: () => {
        replacement = owner.update(input("@replacement"));
      },
    }],
    fail: (error) => {
      throw error;
    },
  });
  try {
    await owner.update(input("@original"));
    owner.choose(0);
    await replacement;
    assertEquals(owner.state.token?.query, "replacement");
    assertEquals(owner.state.options, [{
      id: "replacement",
      label: "replacement",
    }]);
    assertEquals(owner.state.visible, true);
  } finally {
    owner.dispose();
  }
});
