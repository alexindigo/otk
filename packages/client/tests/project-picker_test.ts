// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import * as client from "@otk/client";
import type { StateFactory, StateStore } from "@otk/client";

function setup(factory?: StateFactory) {
  let connection = { sidecarId: "first", key: 1, connected: true };
  const requests: {
    id: string;
    signal: AbortSignal;
    result: ReturnType<typeof Promise.withResolvers<string[]>>;
  }[] = [];
  const additions: {
    id: string;
    directory: string;
    result: ReturnType<typeof Promise.withResolvers<{ directory: string }>>;
  }[] = [];
  const opened: { sidecarId: string; directory: string }[] = [];
  let closed = 0;
  const owner = client.createProjectPicker({
    connection: () => connection,
    scan: (id, signal) => {
      const result = Promise.withResolvers<string[]>();
      requests.push({ id, signal, result });
      return result.promise;
    },
    add: (id, directory) => {
      const result = Promise.withResolvers<{ directory: string }>();
      additions.push({ id, directory, result });
      return result.promise;
    },
    open: (project) => {
      opened.push(project);
    },
    close: () => {
      closed++;
    },
    factory,
  });
  return {
    owner,
    requests,
    additions,
    opened,
    closed: () => closed,
    connection: (value: typeof connection) => {
      connection = value;
    },
  };
}

Deno.test("project picker invalidates every scan field on disconnect and joins the replacement connection", async () => {
  const f = setup();
  try {
    f.owner.connect();
    const old = f.owner.refresh();
    await Promise.resolve();
    assertEquals(f.requests.length, 1);
    assertEquals(f.owner.state.loading, true);
    f.connection({ sidecarId: "first", key: 1, connected: false });
    f.owner.connect();
    assertEquals(f.owner.state, {
      connected: false,
      paths: [],
      loading: false,
      error: "",
    });
    assertEquals(f.requests[0].signal.aborted, true);
    await f.owner.ready();
    f.connection({ sidecarId: "first", key: 2, connected: true });
    const ready = f.owner.ready();
    await Promise.resolve();
    assertEquals(f.requests.length, 2);
    f.requests[1].result.resolve(["/fresh"]);
    await ready;
    f.requests[0].result.resolve(["/stale"]);
    await old;
    assertEquals(f.owner.state, {
      connected: true,
      paths: ["/fresh"],
      loading: false,
      error: "",
    });
  } finally {
    f.owner.dispose();
  }
});

Deno.test("project picker owns server and welcome identity, current failures and explicit retry", async () => {
  const f = setup();
  try {
    const first = f.owner.refresh();
    await Promise.resolve();
    f.connection({ sidecarId: "second", key: 1, connected: true });
    f.owner.connect();
    const second = f.owner.ready();
    await Promise.resolve();
    assertEquals(f.requests.map((request) => request.id), ["first", "second"]);
    f.requests[0].result.reject(new Error("retired failure"));
    await first;
    assertEquals(f.owner.state.error, "");
    f.requests[1].result.reject(new Error("scan failed"));
    await second;
    assertEquals(f.owner.state, {
      connected: true,
      paths: [],
      loading: false,
      error: "scan failed",
    });
    await f.owner.ready();
    assertEquals(
      f.requests.length,
      2,
      "Readiness must not retry a failed scan",
    );
    const retry = f.owner.refresh();
    await Promise.resolve();
    f.requests[2].result.resolve(["/retry"]);
    await retry;
    assertEquals(f.owner.state.paths, ["/retry"]);
    assertEquals(f.owner.state.error, "");
    // A coalesced reconnect may retain the same connected status. Its welcome
    // version must still invalidate the previous directory catalog.
    f.connection({ sidecarId: "second", key: 2, connected: true });
    f.owner.connect();
    assertEquals(f.owner.state.paths, []);
    const reconnected = f.owner.ready();
    await Promise.resolve();
    assertEquals(f.requests.length, 4);
    f.requests[3].result.resolve(["/reconnected"]);
    await reconnected;
    assertEquals(f.owner.state.paths, ["/reconnected"]);
  } finally {
    f.owner.dispose();
  }
});

Deno.test("project picker reserves in-flight work before notifying reentrant consumers", async () => {
  const f = setup();
  let joined: Promise<void> | undefined;
  const release = f.owner.subscribe((state) => {
    if (state.loading && !joined) joined = f.owner.refresh();
  });
  try {
    const ready = f.owner.ready();
    await Promise.resolve();
    assertEquals(f.requests.length, 1);
    f.requests[0].result.resolve(["/shared"]);
    await Promise.all([ready, joined]);
    assertEquals(f.owner.state.paths, ["/shared"]);
  } finally {
    release();
    f.owner.dispose();
  }
});

Deno.test("project picker reads current state with deferred publication and fences disposal through late settlement", async () => {
  const publications: (() => void)[] = [];
  const factory: StateFactory = <T extends object>(
    initial: T,
  ): StateStore<T> => {
    const queued = structuredClone(initial);
    return {
      state: initial,
      update(change) {
        change(queued);
        publications.push(() => Object.assign(initial, queued));
      },
      reconcile(target, value) {
        Object.assign(target, value);
      },
      subscribe: () => () => {},
    };
  };
  const f = setup(factory);
  const work = f.owner.refresh();
  await Promise.resolve();
  assertEquals(f.owner.state.loading, true);
  const ready = f.owner.ready();
  f.owner.dispose();
  await ready;
  const state = structuredClone(f.owner.state), count = publications.length;
  f.requests[0].result.reject(new Error("late disposed failure"));
  await work;
  assertEquals(f.owner.state, state);
  assertEquals(publications.length, count);
  await f.owner.refresh();
  assertEquals(f.requests.length, 1);
  for (const publish of publications) publish();
  assertEquals(f.owner.state, state);
});

Deno.test("project addition captures its server and normalized path and shares duplicate submissions", async () => {
  const f = setup();
  try {
    const work = f.owner.add({ sidecarId: "first", directory: "  /chosen  " });
    const duplicate = f.owner.add({ sidecarId: "first", directory: "/chosen" });
    assertStrictEquals(work, duplicate);
    await Promise.resolve();
    f.connection({ sidecarId: "second", key: 1, connected: true });
    assertEquals(f.additions.map(({ id, directory }) => ({ id, directory })), [{
      id: "first",
      directory: "/chosen",
    }]);
    assertEquals(f.opened, []);
    assertEquals(f.closed(), 0);
    f.additions[0].result.resolve({ directory: "/canonical/chosen" });
    await work;
    assertEquals(f.opened, [{
      sidecarId: "first",
      directory: "/canonical/chosen",
    }]);
    assertEquals(f.closed(), 1);
  } finally {
    f.owner.dispose();
  }
});

Deno.test("project addition propagates failure, permits retry and cannot navigate or close after disposal", async () => {
  const f = setup();
  const input = { sidecarId: "first", directory: "/chosen" };
  const failed = f.owner.add(input),
    rejection = assertRejects(() => failed, Error, "add failed");
  await Promise.resolve();
  f.additions[0].result.reject(new Error("add failed"));
  await rejection;
  assertEquals(f.opened, []);
  assertEquals(f.closed(), 0);
  const retry = f.owner.add(input);
  await Promise.resolve();
  assertEquals(f.additions.length, 2);
  f.owner.dispose();
  f.additions[1].result.resolve({ directory: "/chosen" });
  await retry;
  assertEquals(f.opened, []);
  assertEquals(f.closed(), 0);
});
