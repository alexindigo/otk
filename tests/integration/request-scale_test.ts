// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { RequestTracker } from "@otk/client";
import type { Harness } from "@otk/harness";
import type { RequestControl, RequestEvent } from "@otk/protocol";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import { RequestCoordinator, RpcRegistry } from "../../core/mod.ts";
import { cfg } from "../support/config.ts";
import { tempDir, test } from "../support/resources.ts";
import { servingProbe } from "../support/serving-probe.ts";

declare module "@otk/protocol" {
  interface RpcMethods {
    "qualification.read": { params: { index: number }; result: string };
  }
}

test("request admission bounds active input and replay while bounded reconnect batches settle every consumer", async () => {
  const db = new OtkDb(await tempDir("rq-scale-"), [requestsMigrations], {
    busyms: 5000,
  });
  const registry = new RpcRegistry({} as Harness, db),
    receipts = new Requests(db);
  const held = Promise.withResolvers<void>();
  let calls = 0;
  registry.register("qualification.read", {
    params: (p) => ({ index: Number(p.index) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: async (_ctx, p) => {
      calls++;
      await held.promise;
      return `${p.index}:` + "provider-only-body".repeat(128);
    },
  });
  const policy = {
    ...cfg().requests,
    maxpending: 64,
    resumebatch: 7,
    resultbytes: 128,
  };
  const coordinator = new RequestCoordinator({ registry, receipts, policy });
  const probe = servingProbe(),
    frames: RequestControl[] = [],
    events: RequestEvent[] = [];
  let consumer = {
    send(event: RequestEvent) {
      events.push(event);
      tracker.receive(event);
    },
    lease: { id: "first", signal: new AbortController().signal, defer() {} },
  };
  const deliveries: Promise<void>[] = [];
  const tracker = new RequestTracker({
    kind: () => "read",
    send: (frame) => {
      frames.push(frame);
      deliveries.push(coordinator.accept("scale", frame, consumer));
    },
  });
  await coordinator.start();
  tracker.connect(coordinator.window(), policy.resumebatch);
  try {
    const operations = Array.from(
      { length: 64 },
      (_, index) => tracker.start("qualification.read", { index }),
    );
    await Promise.all(deliveries);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(calls, 64);
    assert(
      operations.every((operation) =>
        !["failed", "succeeded"].includes(operation.state.phase)
      ),
    );
    const extra = {
      ...operations[0].state.ref,
      key: crypto.randomUUID(),
      id: crypto.randomUUID(),
    };
    await coordinator.accept("scale", {
      t: "request",
      ref: extra,
      method: "qualification.read",
      params: { index: 65 },
    }, consumer);
    const rejected = events.at(-1);
    assert(rejected?.t === "request.rejected");
    assertEquals(rejected.error.code, "request.capacity");
    coordinator.detach(consumer);
    tracker.disconnect();
    consumer = { ...consumer, lease: { ...consumer.lease, id: "replacement" } };
    const reconnectStart = frames.length;
    tracker.connect(coordinator.window(), policy.resumebatch);
    await Promise.all(deliveries);
    const resumes = frames.slice(reconnectStart).filter((frame) =>
      frame.t === "request.resume"
    );
    assertEquals(resumes.flatMap((frame) => frame.items).length, 64);
    assert(resumes.every((frame) => frame.items.length <= policy.resumebatch));
    held.resolve();
    await coordinator.idle();
    const results = await Promise.all(
      operations.map((operation) => operation.result),
    );
    assertEquals(new Set(results).size, 64);
    assertEquals(calls, 64, "Reconnection joins the original read generation");
    assert(
      operations.every((operation) => operation.state.phase === "succeeded"),
    );
    assertEquals(receipts.inFlight(undefined, 128), []);
    const persisted = db.connection.prepare(
      "SELECT receipt_json FROM request_receipts",
    ).all();
    assertEquals(
      JSON.stringify(persisted).includes("provider-only-body"),
      false,
    );
    const sample = operations[0].state.ref;
    // A consumer resupplies its captured read parameters under the same key;
    // body/parameters are not reconstructed from a metadata-only receipt.
    const replay: RequestEvent[] = [];
    await coordinator.accept("scale", {
      t: "request",
      ref: { ...sample, id: crypto.randomUUID() },
      method: "qualification.read",
      params: { index: 0 },
    }, { ...consumer, send: (event) => replay.push(event) });
    await coordinator.idle();
    const result = replay.at(-1);
    assert(result?.t === "request.result" && result.outcome.ok);
    assertEquals(result.outcome.result, results[0]);
    assertEquals(calls, 65);
    console.info("Request scale measurements", {
      requests: 64,
      resumeFrames: resumes.length,
      maxLagMs: Math.max(...probe.samples.map((s) => s.ms)),
      resultBytes: results[0].length,
    });
  } finally {
    held.resolve();
    tracker.stop();
    await coordinator.stop();
    probe.stop();
    db.close();
  }
});

test("aggregate captured input and oversized resume controls reject before accepting more work", async () => {
  const db = new OtkDb(await tempDir("rq-bytes-"), [requestsMigrations], {
    busyms: 5000,
  });
  const registry = new RpcRegistry({} as Harness, db);
  const held = Promise.withResolvers<void>();
  let calls = 0;
  registry.register("qualification.read", {
    params: (p) => ({ index: Number(p.index) }),
    execution: {
      kind: "read",
      scope: () => ({}),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    handler: async () => {
      calls++;
      await held.promise;
      return "complete";
    },
  });
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new Requests(db),
    policy: {
      ...cfg().requests,
      inputbytes: 25,
      maxpending: 64,
      resumebatch: 2,
    },
  });
  await coordinator.start();
  const events: RequestEvent[] = [];
  const recipient = {
    send: (event: RequestEvent) => events.push(event),
    lease: { id: "bytes", signal: new AbortController().signal, defer() {} },
  };
  const ref = {
    id: crypto.randomUUID(),
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    window: coordinator.window().id,
  };
  try {
    for (let index = 0; index < 3; index++) {
      await coordinator.accept("bytes", {
        t: "request",
        ref: { ...ref, key: crypto.randomUUID() },
        method: "qualification.read",
        params: { index },
      }, recipient);
    }
    assertEquals(
      events.filter((event) => event.t === "request.accepted").length,
      2,
    );
    const last = events.at(-1);
    assert(last?.t === "request.rejected");
    assertEquals(last.error.code, "request.capacity");
    await coordinator.accept("bytes", {
      t: "request",
      ref,
      method: "qualification.read",
      params: { index: 1, padding: "over budget".repeat(5) },
    }, recipient);
    const oversized = events.at(-1);
    assert(oversized?.t === "request.rejected");
    assertEquals(oversized.error.code, "request.capacity");
    await assertRejects(
      () =>
        coordinator.accept("bytes", {
          t: "request.resume",
          items: Array.from({ length: 3 }, () => ({ ref, after: 0 })),
        }, recipient),
      TypeError,
      "batch too large",
    );
    held.resolve();
    await coordinator.idle();
    assertEquals(calls, 2);
    assertEquals(
      events.filter((event) => event.t === "request.result" && event.outcome.ok)
        .length,
      2,
    );
  } finally {
    held.resolve();
    await coordinator.stop();
    db.close();
  }
});
