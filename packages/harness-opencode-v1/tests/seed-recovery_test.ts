// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { MessageRecovery } from "../recovery.ts";
import type { NativeMessage } from "../messages.ts";

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(concurrency = 2, pending = 128) {
  const reads: {
    session: string;
    message: string;
    signal: AbortSignal;
    result: ReturnType<typeof Promise.withResolvers<NativeMessage>>;
  }[] = [];
  const emitted: {
    session: string;
    message: string;
    parts: string[];
    terminal: boolean;
    generation: number;
  }[] = [];
  const states: string[] = [],
    reconciled: string[] = [],
    failures: unknown[] = [];
  const recovery = new MessageRecovery({
    concurrency,
    pending,
    wanted: () => true,
    read(session, message, signal) {
      const result = Promise.withResolvers<NativeMessage>();
      reads.push({ session, message, signal, result });
      return result.promise;
    },
    emit(session, snapshot, parts, generation, terminal) {
      emitted.push({
        session,
        message: snapshot.info.id,
        parts: [...parts],
        generation,
        terminal,
      });
    },
    state: (_session, _message, part, _generation, state) =>
      states.push(`${part}:${state}`),
    reconcile: (session) => reconciled.push(session),
    failed: (error) => failures.push(error),
  });
  const snapshot = (message: string): NativeMessage => ({
    info: {
      id: message,
      sessionID: "native",
      role: "assistant",
      agent: "build",
      time: { created: 1 },
      providerID: "fake",
      modelID: "scripted",
    },
    parts: [],
  });
  const finish = async () => {
    const stopped = recovery.stop();
    for (const read of reads) read.result.resolve(snapshot(read.message));
    await stopped;
  };
  return {
    recovery,
    reads,
    emitted,
    states,
    failures,
    reconciled,
    snapshot,
    finish,
  };
}

Deno.test("missing seed retains identities, never deltas or repeated checkpoint intents", async () => {
  const f = fixture();
  try {
    f.recovery.touch("s", "m", "p");
    await tick();
    for (let i = 0; i < 1000; i++) f.recovery.touch("s", "m", "p");
    assertEquals(f.reads.length, 1);
    f.reads[0].result.resolve(f.snapshot("m"));
    await tick();
    for (let i = 0; i < 1000; i++) f.recovery.touch("s", "m", "p");
    await tick();
    assertEquals(f.reads.length, 1);
    assertEquals(f.emitted.length, 1);
    assertEquals(f.states, ["p:recovering"]);
    assertEquals(f.recovery.snapshot("s"), [{
      messageID: "m",
      partID: "p",
      generation: 1,
    }]);
    f.recovery.terminal("s", "m");
    await tick();
    assertEquals(f.reads.length, 2);
    f.reads[1].result.resolve(f.snapshot("m"));
    await tick();
    assert(f.emitted[1].terminal);
    assertEquals(f.recovery.snapshot("s"), []);
    assertEquals(f.states.at(-1), "p:ready");
    f.recovery.touch("s", "m", "p");
    await tick();
    assertEquals(
      f.reads.length,
      2,
      "terminal checkpoints are barriers to late deltas",
    );
  } finally {
    await f.finish();
  }
});

Deno.test("checkpoint admission is adapter-wide, queued cancellation and session identities are independent", async () => {
  const f = fixture();
  try {
    f.recovery.touch("a", "same", "p");
    f.recovery.touch("b", "same", "p");
    f.recovery.touch("c", "third", "p");
    f.recovery.touch("d", "cancel", "p");
    f.recovery.release("d");
    await tick();
    assertEquals(f.reads.map((r) => r.session), ["a", "b"]);
    f.reads[0].result.resolve(f.snapshot("same"));
    await tick();
    assertEquals(f.reads.map((r) => r.session), ["a", "b", "c"]);
    f.recovery.part("same", "p", "b");
    assert(f.reads[1].signal.aborted);
    f.reads[1].result.resolve(f.snapshot("same"));
    await tick();
    assertEquals(f.emitted.map((r) => r.session), ["a"]);
  } finally {
    await f.finish();
  }
});

Deno.test("authoritative part fences a late HTTP response and a terminal read supersedes initial work", async () => {
  const f = fixture(2);
  try {
    f.recovery.touch("s", "m", "p");
    await tick();
    f.recovery.part("m", "p", "s");
    f.reads[0].result.resolve(f.snapshot("m"));
    await tick();
    assertEquals(f.emitted.length, 0);
    f.recovery.touch("s", "m", "p");
    await tick();
    f.recovery.terminal("s", "m");
    assert(f.reads[1].signal.aborted);
    await tick();
    assertEquals(
      f.reads.length,
      2,
      "supersession joins cancelled work before a same-message checkpoint",
    );
    f.reads[1].result.resolve(f.snapshot("m"));
    await tick();
    assertEquals(f.reads.length, 3);
    f.reads[2].result.resolve(f.snapshot("m"));
    await tick();
    assertEquals(f.emitted.map((e) => e.terminal), [true]);
  } finally {
    await f.finish();
  }
});

Deno.test("failed checkpoint stays unavailable until an explicit retry or distinct authoritative checkpoint", async () => {
  const f = fixture();
  try {
    f.recovery.touch("s", "m", "p");
    await tick();
    f.reads[0].result.reject(new Error("offline"));
    await tick();
    for (let i = 0; i < 1000; i++) f.recovery.touch("s", "m", "p");
    await tick();
    assertEquals(f.reads.length, 1);
    assertEquals(f.states.at(-1), "p:unavailable");
    f.recovery.retry("s");
    await tick();
    assertEquals(f.reads.length, 2);
    f.reads[1].result.reject(new Error("offline"));
    await tick();
    f.recovery.checkpoint("s", "m", "header-2");
    f.recovery.checkpoint("s", "m", "header-2");
    await tick();
    assertEquals(f.reads.length, 3);
    assertEquals(f.failures.length, 2);
  } finally {
    await f.finish();
  }
});

Deno.test("pending fine identities collapse to one source-free scoped reconciliation marker", async () => {
  const f = fixture(1, 2);
  try {
    f.recovery.touch("s", "m1", "p1");
    f.recovery.touch("s", "m2", "p2");
    f.recovery.touch("s", "m3", "p3");
    for (let i = 0; i < 10000; i++) f.recovery.touch("s", `m${i}`, `p${i}`);
    await tick();
    assertEquals(f.reconciled, ["s"]);
    assertEquals(f.recovery.snapshot("s"), []);
    assert(f.recovery.scoped("s"));
    assertEquals(f.reads.length, 0);
    f.recovery.terminal("s");
    f.recovery.terminal("s");
    assertEquals(
      f.reconciled,
      ["s", "s"],
      "one terminal reconciliation replaces lost fine checkpoints",
    );
    f.recovery.release("s");
    assert(!f.recovery.scoped("s"));
    f.recovery.touch("s", "fresh", "p");
    await tick();
    assertEquals(f.reads.length, 1);
  } finally {
    await f.finish();
  }
});
