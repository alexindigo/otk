// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { RequestTracker, Rpc } from "@otk/client";
import {
  OperationFailure,
  type RequestEvent,
  type RequestPolicy,
} from "@otk/protocol";
import type { Harness } from "@otk/harness";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Requests,
  requestsMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { IndexStore, RequestCoordinator, RpcRegistry } from "../../core/mod.ts";
import { InboxFeature } from "../../core/features/inbox.ts";
import { cfg } from "../support/config.ts";
import { tempDir, test } from "../support/resources.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "probe.native": { params: { value: string }; result: null };
    "probe.read": { params: { value: string }; result: string };
  }
}
const policy: RequestPolicy = {
  windowms: 10000,
  retentionms: 10000,
  maxpending: 8,
  inputbytes: 10000,
  resultbytes: 100,
  resumebatch: 2,
  sweepbatch: 2,
  livenessms: 5,
  stoppingms: 5,
};
const recipient = (events: RequestEvent[]) => ({
  send: (event: RequestEvent) => {
    events.push(event);
  },
  lease: {
    id: crypto.randomUUID(),
    signal: new AbortController().signal,
    defer() {},
  },
});

test("fenced native ambiguity survives disconnect and coordinator restart without redispatch", async () => {
  const root = await tempDir("request-recovery-");
  let calls = 0;
  const db = new OtkDb(root, [requestsMigrations]), receipts = new Requests(db);
  const registry = new RpcRegistry({} as Harness, db);
  registry.register("probe.native", {
    params: (p) => ({ value: String(p.value) }),
    execution: {
      kind: "native",
      scope: () => ({ sessionID: "tstv1-session" }),
      receipt: () => undefined,
      recover: () =>
        Promise.resolve({
          state: "pending",
          progress: { phase: "reconciling", code: "checking-outcome" },
        }),
    },
    handler: async (ctx) => {
      await ctx.execution!.beforeEffect();
      calls++;
      throw new OperationFailure(
        "unknown",
        "native.unknown",
        new Error("private cause"),
      );
    },
  });
  let coordinator = new RequestCoordinator({ registry, receipts, policy });
  await coordinator.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  const events: RequestEvent[] = [], consumer = recipient(events);
  try {
    await coordinator.accept("user", {
      t: "request",
      ref,
      method: "probe.native",
      params: { value: "secret prompt" },
    }, consumer);
    await coordinator.idle();
    assertEquals(calls, 1);
    assertEquals(events.at(-1)?.t, "request.progress");
    assertEquals(
      receipts.get({
        principal: "user",
        client_id: ref.clientID,
        intent_key: ref.key,
      })?.state,
      "reconciling",
    );
    coordinator.detach(consumer);
    await coordinator.stop();
    coordinator = new RequestCoordinator({ registry, receipts, policy });
    await coordinator.start();
    await coordinator.idle();
    await coordinator.accept("user", {
      t: "request",
      ref: { ...ref, id: crypto.randomUUID() },
      method: "probe.native",
      params: { value: "secret prompt" },
    }, consumer);
    await coordinator.idle();
    assertEquals(calls, 1);
    assertEquals(events.some((event) => event.t === "request.result"), false);
    assertEquals(
      JSON.stringify(receipts.inFlight(undefined, 8)).includes("secret prompt"),
      false,
    );
  } finally {
    await coordinator.stop();
    db.close();
  }
});

test("read cancellation is recipient-owned, liveness is nonterminal and success can reload volatile data", async () => {
  const db = new OtkDb(await tempDir("request-read-"), [requestsMigrations]);
  const receipts = new Requests(db),
    registry = new RpcRegistry({} as Harness, db);
  let calls = 0, aborted = false;
  let held = Promise.withResolvers<string>();
  registry.register("probe.read", {
    params: (p) => ({ value: String(p.value) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: (ctx) => {
      calls++;
      ctx.execution!.signal.addEventListener("abort", () => {
        aborted = true;
        held.reject(ctx.execution!.signal.reason);
      }, { once: true });
      return held.promise;
    },
  });
  const coordinator = new RequestCoordinator({ registry, receipts, policy });
  await coordinator.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  const firstEvents: RequestEvent[] = [],
    secondEvents: RequestEvent[] = [],
    first = recipient(firstEvents),
    second = recipient(secondEvents);
  try {
    await coordinator.accept("u", {
      t: "request",
      ref,
      method: "probe.read",
      params: { value: "one" },
    }, first);
    await coordinator.accept("u", {
      t: "request.resume",
      items: [{ ref, after: 0 }],
    }, second);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assertEquals(
      firstEvents.some((event) => event.t === "request.result"),
      false,
    );
    await coordinator.accept("u", { t: "request.release", refs: [ref] }, first);
    assertEquals(aborted, false);
    held.resolve("current data");
    await coordinator.idle();
    assertEquals(secondEvents.at(-1)?.t, "request.result");
    const record = receipts.get({
      principal: "u",
      client_id: ref.clientID,
      intent_key: ref.key,
    })!;
    await coordinator.accept("u", {
      t: "request.received",
      refs: [{ ref, seq: record.seq }],
    }, second);
    held = Promise.withResolvers<string>();
    held.resolve("new current data");
    await coordinator.accept("u", {
      t: "request",
      ref: { ...ref, id: crypto.randomUUID() },
      method: "probe.read",
      params: { value: "one" },
    }, second);
    await coordinator.idle();
    assertEquals(calls, 2);
    const final = secondEvents.at(-1);
    assertEquals(
      final?.t === "request.result" && final.outcome.ok
        ? final.outcome.result
        : undefined,
      "new current data",
    );
    assertEquals(receipts.get(record)?.seq, record.seq);
  } finally {
    await coordinator.stop();
    db.close();
  }
});

test("a lost admission asks for the same payload while expired unknown intents cannot execute", async () => {
  const db = new OtkDb(await tempDir("request-admission-"), [
    requestsMigrations,
  ]);
  const receipts = new Requests(db),
    registry = new RpcRegistry({} as Harness, db);
  const coordinator = new RequestCoordinator({ registry, receipts, policy });
  await coordinator.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  const events: RequestEvent[] = [], consumer = recipient(events);
  try {
    await coordinator.accept("u", {
      t: "request.resume",
      items: [{ ref, after: 0 }],
    }, consumer);
    const event = events.at(-1);
    assertEquals(
      event?.t === "request.rejected" ? event.error.code : undefined,
      "request.input-required",
    );
    await coordinator.accept("u", {
      t: "request.resume",
      items: [{ ref: { ...ref, window: crypto.randomUUID() }, after: 0 }],
    }, consumer);
    const expired = events.at(-1);
    assertEquals(
      expired?.t === "request.rejected" ? expired.error.code : undefined,
      "request.expired",
    );
  } finally {
    await coordinator.stop();
    db.close();
  }
});

test("two SQLite-backed coordinators cannot dispatch one native intent twice or turn contention into failure", async () => {
  const root = await tempDir("request-contender-");
  const firstDb = new OtkDb(root, [requestsMigrations]),
    secondDb = new OtkDb(root, [requestsMigrations]);
  let calls = 0;
  const make = (db: OtkDb) => {
    const registry = new RpcRegistry({} as Harness, db);
    registry.register("probe.native", {
      params: (p) => ({ value: String(p.value) }),
      execution: {
        kind: "native",
        scope: () => ({ sessionID: "tstv1-session" }),
        receipt: () => undefined,
        recover: () =>
          Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          }),
      },
      handler: async (ctx) => {
        await ctx.execution!.beforeEffect();
        calls++;
        return null;
      },
    });
    return new RequestCoordinator({
      registry,
      receipts: new Requests(db),
      policy,
    });
  };
  const first = make(firstDb), second = make(secondDb);
  await first.start();
  await second.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: first.window().id,
  };
  const events: RequestEvent[] = [], consumer = recipient(events);
  try {
    await Promise.all([
      first.accept("u", {
        t: "request",
        ref,
        method: "probe.native",
        params: { value: "same" },
      }, consumer),
      second.accept("u", {
        t: "request",
        ref: { ...ref, id: crypto.randomUUID() },
        method: "probe.native",
        params: { value: "same" },
      }, consumer),
    ]);
    await Promise.all([first.idle(), second.idle()]);
    assertEquals(calls, 1);
    assertEquals(
      events.some((event) => event.t === "request.result" && !event.outcome.ok),
      false,
    );
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    firstDb.close();
    secondDb.close();
  }
});

test("read readiness yields existing interactive pressure and last release cancels only its owned read", async () => {
  const db = new OtkDb(await tempDir("request-pressure-"), [
    requestsMigrations,
  ]);
  const active = new Set<string>();
  const registry = new RpcRegistry({} as Harness, db, (owner, running) => {
    if (running) active.add(owner);
    else active.delete(owner);
  });
  let calls = 0, aborted = false;
  const held = Promise.withResolvers<string>();
  registry.register("probe.read", {
    params: (p) => ({ value: String(p.value) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: (ctx) => {
      calls++;
      ctx.execution!.signal.addEventListener("abort", () => {
        aborted = true;
        held.reject(ctx.execution!.signal.reason);
      }, { once: true });
      return ctx.execution!.wait!(held.promise);
    },
  });
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new Requests(db),
    policy: { ...policy, maxpending: 1 },
  });
  await coordinator.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  const events: RequestEvent[] = [], consumer = recipient(events);
  try {
    await coordinator.accept("u", {
      t: "request",
      ref,
      method: "probe.read",
      params: { value: "first" },
    }, consumer);
    while (!calls) await new Promise((resolve) => setTimeout(resolve, 1));
    assertEquals(active.size, 0);
    await coordinator.accept("u", {
      t: "request",
      ref: { ...ref, key: crypto.randomUUID() },
      method: "probe.read",
      params: { value: "second" },
    }, consumer);
    const rejected = events.at(-1);
    assertEquals(
      rejected?.t === "request.rejected" ? rejected.error.code : undefined,
      "request.capacity",
    );
    assertEquals(calls, 1);
    await coordinator.accept("u", {
      t: "request.release",
      refs: [{ ...ref, key: crypto.randomUUID() }],
    }, consumer);
    assertEquals(aborted, false);
    await coordinator.accept(
      "u",
      { t: "request.release", refs: [ref] },
      consumer,
    );
    await coordinator.idle();
    assertEquals(aborted, true);
    assertEquals(active.size, 0);
  } finally {
    held.resolve("cleanup");
    await coordinator.stop();
    db.close();
  }
});

test("resume retries an unavailable read and rechecks a native outcome without redispatch", async () => {
  const db = new OtkDb(await tempDir("request-resume-"), [requestsMigrations]),
    registry = new RpcRegistry({} as Harness, db);
  let reads = 0, effects = 0, confirmed = false;
  registry.register("probe.read", {
    params: (p) => ({ value: String(p.value) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: () => {
      if (++reads === 1) {
        throw new OperationFailure(
          "unavailable",
          "native.unavailable",
          new Error("link unavailable"),
        );
      }
      return "recovered read";
    },
  });
  registry.register("probe.native", {
    params: (p) => ({ value: String(p.value) }),
    execution: {
      kind: "native",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () =>
        Promise.resolve(
          confirmed ? { state: "complete", result: null } : {
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          },
        ),
    },
    handler: async (ctx) => {
      await ctx.execution!.beforeEffect();
      effects++;
      throw new OperationFailure(
        "unknown",
        "native.unknown",
        new Error("lost response"),
      );
    },
  });
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new Requests(db),
    policy,
  });
  await coordinator.start();
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  const nativeRef = { ...ref, key: crypto.randomUUID() };
  const events: RequestEvent[] = [], consumer = recipient(events);
  try {
    await coordinator.accept("u", {
      t: "request",
      ref,
      method: "probe.read",
      params: { value: "same" },
    }, consumer);
    await coordinator.idle();
    await coordinator.accept("u", {
      t: "request.resume",
      items: [{ ref, after: 0 }],
    }, consumer);
    await coordinator.idle();
    assertEquals(reads, 2);
    const readResult = events.at(-1);
    assertEquals(
      readResult?.t === "request.result" && readResult.outcome.ok
        ? readResult.outcome.result
        : undefined,
      "recovered read",
    );
    await coordinator.accept("u", {
      t: "request",
      ref: nativeRef,
      method: "probe.native",
      params: { value: "same" },
    }, consumer);
    await coordinator.idle();
    confirmed = true;
    await coordinator.accept("u", {
      t: "request.resume",
      items: [{ ref: nativeRef, after: 0 }],
    }, consumer);
    await coordinator.idle();
    assertEquals(effects, 1);
    assertEquals(events.at(-1)?.t, "request.result");
  } finally {
    await coordinator.stop();
    db.close();
  }
});

test("actual task creation stays pending for forty seconds through same-intent retry and transport replacement", async () => {
  const root = await tempDir("task-request-wallclock-");
  const db = new OtkDb(root, [
    requestsMigrations,
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  const entered = Promise.withResolvers<void>(),
    validation = Promise.withResolvers<void>();
  let lookups = 0;
  const harness = {
    core: {
      identities: async (ids: readonly string[]) => {
        lookups++;
        entered.resolve();
        await validation.promise;
        return ids.map((id) => ({ id, directory: "/p" }));
      },
    },
    capabilities: {},
  } as unknown as Harness;
  const tasks = new Tasks(db),
    receipts = new Requests(db),
    active = new Set<string>();
  const registry = new RpcRegistry(harness, db, (owner, running) => {
    if (running) active.add(owner);
    else active.delete(owner);
  });
  const inbox = new InboxFeature(
    {
      projects: new Projects(db),
      tasks,
      seen: new Seen(db),
      finishes: new Finishes(db),
      templates: new ProjectTemplates(db),
    },
    new IndexStore(),
    "local",
    () => Promise.resolve([]),
  );
  inbox.register(registry);
  const coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  await coordinator.start();
  const deliveries: Promise<void>[] = [],
    events: { elapsed: number; event: RequestEvent }[] = [];
  const started = performance.now();
  let recipient = {
    send: (event: RequestEvent) => {
      events.push({ elapsed: performance.now() - started, event });
      tracker.receive(event);
    },
    lease: { id: "first", signal: new AbortController().signal, defer() {} },
  };
  const tracker = new RequestTracker({
    send: (frame) => {
      deliveries.push(coordinator.accept("local", frame, recipient));
    },
  });
  tracker.connect(coordinator.window(), cfg().requests.resumebatch);
  const rpc = new Rpc(() => {
    throw new Error("Legacy transport must not execute");
  }, tracker);
  const operation = rpc.start("tasks.create", {
    directory: "/p",
    name: "perf",
    sessions: ["tstv1-session"],
  }, { owner: "project:/p" });
  const observations: {
    elapsed: number;
    phase: string;
    connection: string;
    tasks: number;
  }[] = [];
  const inspect = () => {
    observations.push({
      elapsed: performance.now() - started,
      phase: operation.state.phase,
      connection: operation.state.connection,
      tasks: tasks.list().length,
    });
    assert(
      !["failed", "succeeded", "released"].includes(operation.state.phase),
    );
    assertEquals(operation.state.error, undefined);
    assertEquals(tasks.list(), []);
    assertEquals(
      active.size,
      0,
      "Authoritative validation must yield interactive pressure",
    );
  };
  try {
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 16000));
    inspect();
    const identity = { ...operation.state.ref };
    assertEquals(
      rpc.start("tasks.create", {
        directory: "/p",
        name: "perf",
        sessions: ["tstv1-session"],
      }, { intent: identity }),
      operation,
    );
    operation.retry();
    coordinator.detach(recipient);
    tracker.disconnect();
    inspect();
    recipient = { ...recipient, lease: { ...recipient.lease, id: "second" } };
    tracker.connect(coordinator.window(), cfg().requests.resumebatch);
    await Promise.all(deliveries);
    await new Promise((resolve) => setTimeout(resolve, 15000));
    inspect();
    assertEquals(operation.state.ref.key, identity.key);
    await new Promise((resolve) => setTimeout(resolve, 9000));
    validation.resolve();
    await coordinator.idle();
    const task = await operation.result;
    assertEquals(operation.state.phase, "succeeded");
    assertEquals(tasks.list(), [task]);
    assertEquals(task.name, "perf");
    assertEquals(lookups, 1);
    assertEquals(
      events.some(({ event }) =>
        event.t === "request.result" && !event.outcome.ok
      ),
      false,
    );
    await Deno.writeTextFile(
      `${root}/proof.json`,
      JSON.stringify({ observations, events, task, lookups }, null, 2),
    );
  } finally {
    validation.resolve();
    tracker.stop();
    await coordinator.stop();
    inbox.close();
    db.close();
  }
});
