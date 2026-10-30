// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { RequestFailure, RequestTracker, Rpc } from "../mod.ts";
import type { RequestControl } from "@otk/protocol";

Deno.test("tracker preserves captured intent across disconnect, replay and same-key retry", async () => {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({
    send: (frame) => sent.push(frame),
    clientID: crypto.randomUUID(),
  });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const operation = tracker.start("tasks.list", { directory: "/p" });
  const ref = operation.state.ref;
  tracker.receive({
    t: "request.accepted",
    ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 10,
    replayed: false,
  });
  tracker.disconnect();
  assertEquals(operation.state.connection, "reconnecting");
  assertEquals(operation.state.phase, "queued");
  operation.retry();
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  assertEquals(sent.at(-1)?.t, "request.resume");
  tracker.receive({
    t: "request.progress",
    ref: operation.state.ref,
    seq: 2,
    progress: { phase: "running", code: "working" },
  });
  tracker.receive({
    t: "request.progress",
    ref: operation.state.ref,
    seq: 1,
    progress: { phase: "queued", code: "queued" },
  });
  assertEquals(operation.state.phase, "running");
  tracker.receive({
    t: "request.result",
    ref: operation.state.ref,
    seq: 3,
    outcome: { ok: true, result: [] },
  });
  assertEquals(await operation.result, []);
  assertEquals(operation.state.ref.key, ref.key);
  tracker.stop();
});

Deno.test("tracker reserves synchronously, rejects changed payload and releases without reporting a failure", async () => {
  const tracker = new RequestTracker({
    send() {},
    clientID: crypto.randomUUID(),
    kind: () => "read",
  });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const operation = tracker.start("tasks.list", { directory: "/p" });
  assertEquals(
    tracker.start("tasks.list", { directory: "/p" }, {
      intent: operation.state.ref,
    }),
    operation,
  );
  const changed = tracker.start("tasks.list", { directory: "/other" }, {
    intent: operation.state.ref,
  });
  await assertRejects(() => changed.result, RequestFailure);
  const released = assertRejects(() => operation.result, Error, "released");
  operation.release();
  await released;
  assertEquals(operation.state.phase, "released");
  tracker.stop();
});

Deno.test("unadmitted resume requests captured payload without creating another intent", () => {
  const sent: RequestControl[] = [];
  const tracker = new RequestTracker({ send: (frame) => sent.push(frame) });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const operation = tracker.start("tasks.list", { directory: "/p" });
  const key = operation.state.ref.key;
  tracker.receive({
    t: "request.rejected",
    ref: operation.state.ref,
    error: {
      code: "request.input-required",
      retry: "same-intent",
      diagnosticID: "opaque",
    },
  });
  assertEquals(operation.state.phase, "waiting");
  assertEquals(sent.at(-1)?.t, "request");
  const last = sent.at(-1);
  assertEquals(last?.t === "request" ? last.ref.key : undefined, key);
  tracker.stop();
});

Deno.test("releasing an accepted mutation detaches the surface but retains its tracked outcome", async () => {
  const tracker = new RequestTracker({ send() {} });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const operation = tracker.start("tasks.close", { id: "task" }, {
    owner: "original-project",
  });
  const ref = operation.state.ref;
  tracker.receive({
    t: "request.accepted",
    ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 10,
    replayed: false,
  });
  operation.release();
  assertEquals(operation.state.phase, "queued");
  tracker.receive({
    t: "request.result",
    ref,
    seq: 2,
    outcome: { ok: true, result: null },
  });
  assertEquals(await operation.result, null);
  tracker.stop();
});

Deno.test("typed Rpc facade receives event results and supports signal-compatible options", async () => {
  const tracker = new RequestTracker({ send() {}, kind: () => "read" });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const rpc = new Rpc(() => {}, tracker);
  const operation = rpc.start("tasks.list", { directory: "/p" });
  rpc.receive({
    t: "request.accepted",
    ref: operation.state.ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 10,
    replayed: false,
  });
  rpc.receive({
    t: "request.result",
    ref: operation.state.ref,
    seq: 2,
    outcome: { ok: true, result: [] },
  });
  assertEquals(await operation.result, []);
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => rpc.call("tasks.list", { directory: "/p" }, controller.signal),
    Error,
    "released",
  );
  tracker.stop();
});

Deno.test("already-cancelled mutation never admits an intent or leaves an unresolved handle", async () => {
  const sent: RequestControl[] = [],
    tracker = new RequestTracker({ send: (frame) => sent.push(frame) });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 },
    2,
  );
  const controller = new AbortController();
  controller.abort();
  const operation = tracker.start("tasks.close", { id: "task" }, {
    signal: controller.signal,
  });
  assertEquals(operation.state.phase, "released");
  await assertRejects(() => operation.result, Error, "released");
  assertEquals(sent.some((frame) => frame.t === "request"), false);
  tracker.stop();
});

Deno.test("principal replacement keeps another identity's pending actions authentication-required", () => {
  const sent: RequestControl[] = [],
    tracker = new RequestTracker({
      send: (frame) => sent.push(frame),
      principal: "original",
    });
  const window = { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 };
  tracker.connect(window, 2, "original");
  const operation = tracker.start("tasks.close", { id: "task" });
  sent.length = 0;
  tracker.connect(window, 2, "replacement");
  assertEquals(sent.length, 0);
  assertEquals(operation.state.connection, "authentication-required");
  tracker.connect(window, 2, "original");
  assertEquals(sent.at(-1)?.t, "request.resume");
  assertEquals(operation.state.connection, "connected");
  tracker.stop();
});

Deno.test("reload storage retains only identity metadata and never resubmits a missing payload", () => {
  let saved: unknown;
  const storage = {
    load: () => saved,
    save: (value: unknown) => {
      saved = structuredClone(value);
    },
  };
  const tracker = new RequestTracker({
    send() {},
    server: "consumer",
    storage,
  });
  const window = { id: crypto.randomUUID(), expiresAt: Date.now() + 10000 };
  tracker.connect(window, 2);
  const operation = tracker.capture("example.send", {
    text: "private-prompt-bytes",
  }, { owner: "original-target" });
  assertEquals(JSON.stringify(saved).includes("private-prompt-bytes"), false);
  tracker.stop();
  const sent: RequestControl[] = [];
  const restored = new RequestTracker({
    send: (frame) => sent.push(frame),
    server: "consumer",
    storage,
  });
  restored.connect(window, 2);
  assertEquals(sent[0].t, "request.resume");
  const resumed = restored.operations()[0];
  assertEquals(resumed.state.ref.key, operation.state.ref.key);
  restored.receive({
    t: "request.accepted",
    ref: resumed.state.ref,
    seq: 1,
    acceptedAt: 1,
    retentionUntil: 10,
    replayed: true,
  });
  restored.receive({
    t: "request.progress",
    ref: resumed.state.ref,
    seq: 1,
    progress: { phase: "waiting", code: "input-required" },
  });
  assertEquals(resumed.state.phase, "waiting");
  assertEquals(sent.some((frame) => frame.t === "request"), false);
  restored.stop();
});
