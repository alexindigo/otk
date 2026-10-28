// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import { createSessionUsage, Rpc } from "@otk/client";
import type { SidecarConnection } from "@otk/client";
import { PROTOCOL_VERSION, type ServerFrame } from "@otk/protocol";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { Connections } from "../../../core/ws/connections.ts";
import { IndexStore } from "../../../core/index/store.ts";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { register as registerUsage } from "../../../core/features/usage.ts";
import { prefsOptions } from "../../../core/features/prefs.ts";
import { stub } from "./rpc_test.ts";
import { resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("closing the last breakdown cancels actual worker detail; finished cancels are ignored", async () => {
  const root = await tempDir("digest-read-cancel-");
  let holding = false, started = 0, aborted = 0;
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") {
        return Response.json([{
          id: "ses_one",
          directory: "/p",
          projectID: "p",
          title: "One",
          time: { created: 1, updated: 2 },
        }]);
      }
      if (!holding) return Response.json([]);
      started++;
      return new Promise<Response>((resolve) =>
        request.signal.addEventListener("abort", () => {
          aborted++;
          resolve(Response.json([]));
        }, { once: true })
      );
    },
  );
  resources().defer("native cancel fixture", () => native.shutdown());
  let ready = false;
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
      },
      index: { days: 30 },
    },
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 2,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: (value) => {
      ready ||= value.delta.summary.state === "ready";
    },
  });
  const db = new OtkDb(root, [prefsMigrations]);
  const harness = stub({
    usage: {
      getUsage: (id: string, signal?: AbortSignal) =>
        bridge.detail(id, signal ?? new AbortController().signal),
    },
  });
  const registry = new RpcRegistry(harness, db);
  registerUsage(registry, harness);
  const connections = new Connections(
    harness,
    new IndexStore(),
    "",
    new Prefs(db, prefsOptions),
    registry,
  );
  const frames: ServerFrame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    onmessage: undefined as
      | ((event: MessageEvent) => Promise<void>)
      | undefined,
    onclose: undefined as (() => void) | undefined,
    send(data: string) {
      const frame = JSON.parse(data);
      frames.push(frame);
      rpc.receive(frame);
    },
    close() {
      this.onclose?.();
    },
  };
  const rpc = new Rpc((frame) => {
    void socket.onmessage!(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  });
  const send = (frame: unknown) =>
    socket.onmessage!(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  connections.accept(socket as unknown as WebSocket);
  await send({ t: "hello", protocol: PROTOCOL_VERSION });
  const owner = createSessionUsage(() =>
    ({ supports: () => true, rpc }) as unknown as SidecarConnection
  );
  const target = { sidecarId: "local", sessionID: "opcv1-ses_one" };
  try {
    await bridge.catalog(1, new AbortController().signal);
    await waitFor(() => ready, Boolean);
    holding = true;
    const first = owner.retain(target), last = owner.retain(target);
    const pending = owner.load(target);
    await waitFor(() => started, (n) => n === 1);
    first();
    assertEquals(aborted, 0);
    last();
    await pending;
    await waitFor(() => aborted, (n) => n === 1, 2000);
    holding = false;
    await owner.load(target);
    const completedID = frames.findLast((frame) =>
      frame.t === "rpc.result" && frame.ok
    )?.id;
    const count = frames.length;
    await send({ t: "rpc.cancel", id: completedID });
    await send({ t: "rpc.cancel", id: completedID });
    await send({ t: "rpc.cancel", id: "unknown" });
    assertEquals(frames.length, count);
    assertEquals(aborted, 1);
    await owner.load(target, true);
    assertEquals(owner.get(target)?.total.cost, 0);
  } finally {
    holding = false;
    owner.stop();
    rpc.close();
    connections.close();
    await bridge.stop();
    db.close();
  }
});

test("RPC read cancellation is connection-scoped and ignores completed, duplicate and unknown ids", async () => {
  const db = new OtkDb(await tempDir("rpc-read-cancel-"), [prefsMigrations]);
  const signals: AbortSignal[] = [];
  const harness = stub({
    usage: {
      getUsage: (_id: string, signal?: AbortSignal) => {
        signals.push(signal ?? new AbortController().signal);
        return Promise.resolve({
          sessionID: "tstv1-one",
          messages: [],
          turns: {},
          total: {
            cost: 0,
            models: [],
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        });
      },
    },
  });
  const rpc = new RpcRegistry(harness, db);
  registerUsage(rpc, harness);
  const connections = new Connections(
    harness,
    new IndexStore(),
    "",
    new Prefs(db, prefsOptions),
    rpc,
  );
  const makeSocket = () => {
    const frames: ServerFrame[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      onmessage: undefined as
        | ((event: MessageEvent) => Promise<void>)
        | undefined,
      onclose: undefined as (() => void) | undefined,
      send(data: string) {
        frames.push(JSON.parse(data));
      },
      close() {
        this.onclose?.();
      },
    };
    connections.accept(ws as unknown as WebSocket);
    return {
      frames,
      send: (frame: unknown) =>
        ws.onmessage!(
          new MessageEvent("message", { data: JSON.stringify(frame) }),
        ),
    };
  };
  const first = makeSocket(), second = makeSocket();
  try {
    for (const socket of [first, second]) {
      await socket.send({ t: "hello", protocol: PROTOCOL_VERSION });
    }
    await first.send({
      t: "rpc",
      id: "finished",
      method: "usage.get",
      params: { sessionID: "tstv1-one" },
    });
    const count = first.frames.length;
    await first.send({ t: "rpc.cancel", id: "finished" });
    await first.send({ t: "rpc.cancel", id: "finished" });
    await first.send({ t: "rpc.cancel", id: "unknown" });
    assertEquals(first.frames.length, count);
    assertEquals(signals[0].aborted, false);
    let active: AbortSignal | undefined;
    const gate = Promise.withResolvers<string>();
    rpc.register("external.directory", {
      params: () => undefined,
      handler: (ctx) => {
        active = Reflect.get(ctx, "execution")?.signal;
        return gate.promise;
      },
    });
    const work = first.send({
      t: "rpc",
      id: "active",
      method: "external.directory",
      params: {},
    });
    await second.send({ t: "rpc.cancel", id: "active" });
    assertEquals(active?.aborted, false);
    await first.send({ t: "rpc.cancel", id: "active" });
    assertEquals(active?.aborted, true);
    gate.resolve("finished");
    await work;
    assertEquals(first.frames.filter((frame) => frame.t === "error"), []);
    assertEquals(second.frames.filter((frame) => frame.t === "error"), []);
  } finally {
    connections.close();
    db.close();
  }
});
