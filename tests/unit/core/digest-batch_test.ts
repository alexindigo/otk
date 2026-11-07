// SPDX-License-Identifier: LGPL-3.0-only
import { cfg } from "../../support/config.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DigestBatch } from "../../../core/digest/batch.ts";
import type { DigestWorkerValue } from "../../../core/digest/protocol.ts";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { IndexStore } from "../../../core/index/store.ts";
import { resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("digest packets retain bounded filling/in-flight buffers while consumer credit is held", async () => {
  const held = Promise.withResolvers<void>(), sent: DigestWorkerValue[][] = [];
  const signal = new AbortController().signal;
  const batch = new DigestBatch({
    rows: 2,
    signal,
    wait: (readiness) => readiness,
    schedule: (write) => write(),
    send: async (values) => {
      sent.push(values);
      if (sent.length === 1) await held.promise;
    },
  });
  const value = (revision: number): DigestWorkerValue => ({
    sessionID: `opcv1-ses_${revision}`,
    revision,
    part: 0,
    last: true,
    delta: {
      summary: { state: "ready", revision },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    },
  });
  try {
    for (let i = 0; i < 4; i++) await batch.append(value(i), signal);
    let admitted = false;
    const fifth = batch.append(value(4), signal).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    assertEquals(sent.map((values) => values.length), [2]);
    assertEquals(admitted, false);
    held.resolve();
    await fifth;
    while (batch.flush()) await Promise.resolve();
    await batch.close();
    assertEquals(sent.flat().map((value) => value.revision), [0, 1, 2, 3, 4]);
    assert(sent.every((values) => values.length <= 2));
    const oversized = value(5);
    oversized.delta.turns.remove = ["a", "b", "c"];
    await assertRejects(
      () => batch.append(oversized, signal),
      Error,
      "row budget",
    );
  } finally {
    held.resolve();
    await batch.close();
  }
});

test("bulk digest row credit reaches the index consumer as bounded multi-session patches", async () => {
  const root = await tempDir("db-");
  const entries = Array.from(
    { length: 6 },
    (_, i) => ({
      id: `ses_batch${i}`,
      projectID: "fixture",
      directory: "/fixture",
      title: `Batch ${i}`,
      time: { created: i + 1, updated: i + 1 },
    }),
  );
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") return Response.json(entries);
      if (/^\/session\/[^/]+\/message$/.test(path)) return Response.json([]);
      return new Response("Unexpected fixture request", { status: 500 });
    },
  );
  resources().defer("batch provider", () => native.shutdown());
  const index = new IndexStore(), sizes: number[] = [];
  resources().defer(
    "batch observation",
    index.listen((frame) => {
      if (
        frame.t === "index.patch" && frame.ops.every((op) => op.op === "digest")
      ) sizes.push(frame.ops.length);
    }),
  );
  const bridge = new DigestBridge({
    statePath: root,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${native.addr.port}`,
        username: "",
        password: "",
        db: root + "/absent.db",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 128,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: (value) => {
      index.applyDigest({
        id: value.sessionID,
        revision: value.revision,
        ...value.delta,
      });
    },
  });
  resources().defer("batch bridge", () => bridge.stop());
  bridge.scope("viewer", { sessions: [] });
  await bridge.start();
  const catalog = await bridge.catalog(1, new AbortController().signal);
  for (const entry of catalog.entries) index.upsertMetadata(entry);
  await waitFor(
    () =>
      [...index.values()].filter((entry) => entry.digest.state === "ready")
        .length,
    (n) => n === 6,
  );
  assertEquals([...index.values()].length, 6);
  assert(
    sizes.some((size) => size === 2),
    `one-row publication amplification survives at the consumer: ${sizes}`,
  );
  assert(
    sizes.every((size) => size <= 2),
    `row-credit budget exceeded: ${sizes}`,
  );
});

test("a producer publication fence cannot acknowledge buffered output or wait for a later producer", async () => {
  const first = Promise.withResolvers<void>(),
    later = Promise.withResolvers<void>();
  const signal = new AbortController().signal;
  const sent: number[] = [];
  const batch = new DigestBatch({
    rows: 1,
    signal,
    wait: (ready) => ready,
    schedule: (write) => write(),
    send: async (values) => {
      const revision = values[0].revision;
      sent.push(revision);
      await (revision === 0 ? first.promise : later.promise);
    },
  });
  const append = (revision: number) =>
    batch.append({
      sessionID: `opcv1-ses_${revision}`,
      revision,
      part: 0,
      last: true,
      delta: {
        summary: { state: "ready", revision },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      },
    }, signal);
  try {
    await append(0);
    let acknowledged = false;
    const settled = batch.settle(signal).then(() => {
      acknowledged = true;
    });
    await append(1);
    assertEquals(acknowledged, false);
    first.resolve();
    await waitFor(() => acknowledged, Boolean);
    await settled;
    assertEquals(sent, [0, 1]);
    // The later publication is still held; only the captured prefix is settled.
  } finally {
    first.resolve();
    later.resolve();
    await batch.close();
  }
});
