// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "../support/config.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

async function nativeFixture() {
  const root = await tempDir("demand-idle-");
  const sessions = Array.from({ length: 6 }, (_, i) => ({
    id: `ses_idle${i}`,
    projectID: "idle",
    directory: "/idle",
    title: `Idle ${i}`,
    time: { created: 1, updated: Date.now() - i },
  }));
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let reads = 0, hold = true;
  const release = Promise.withResolvers<void>();
  const emit = (type: string, properties: unknown) => {
    const data = new TextEncoder().encode(
      `data: ${
        JSON.stringify({ directory: "/idle", payload: { type, properties } })
      }\n\n`,
    );
    for (const stream of streams) stream.enqueue(data);
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url), path = url.pathname;
      if (path === "/global/health") {
        return Response.json({
          healthy: true,
          version: "1.18.34",
        });
      }
      if (path === "/global/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.add(controller);
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                ),
              );
              request.signal.addEventListener("abort", () => {
                streams.delete(controller);
                try {
                  controller.close();
                } catch { /* Already cancelled. */ }
              }, { once: true });
            },
            cancel() {/* The request abort retires its stream. */},
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (path === "/experimental/session") return Response.json(sessions);
      if (path === "/session/status") return Response.json({});
      if (path === "/permission" || path === "/question") {
        return Response.json(
          [],
        );
      }
      const session = sessions.find((s) =>
        path === `/session/${s.id}` || path === `/session/${s.id}/message`
      );
      if (session && !path.endsWith("/message")) return Response.json(session);
      if (session) {
        reads++;
        if (hold) {
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else {request.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });}
            }),
          ]);
        }
        return url.searchParams.has("before")
          ? Response.json([])
          : Response.json([{
            info: {
              id: "msg_one",
              sessionID: session.id,
              role: "user",
              time: { created: 1 },
            },
            parts: [],
          }], { headers: { "x-next-cursor": "older" } });
      }
      return Response.json([]);
    },
  );
  resources().defer("idle fake native", async () => {
    release.resolve();
    for (const stream of streams) {
      try {
        stream.close();
      } catch { /* Cancelled. */ }
    }
    streams.clear();
    await server.shutdown();
  });
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.port = 0;
  settings.state.path = join(root, "state");
  settings.harness.url = `http://127.0.0.1:${server.addr.port}`;
  settings.harness.db = join(root, "absent.db");
  settings.digest = {
    ...settings.digest,
    idlems: 500,
    parallel: 2,
    batch: 2,
    cpu: 1,
    memoryreserve: 1,
  };
  return {
    settings,
    reads: () => reads,
    emit,
    release() {
      hold = false;
      release.resolve();
    },
  };
}

test("@load @transport @attention real client ingress postpones idle batches, passive acknowledgements do not, and a new request parks the next chunk", async () => {
  const native = await nativeFixture();
  const app = await start(native.settings);
  const url = `http://127.0.0.1:${app.server.addr.port}`;
  const client = new WsClient(url);
  try {
    await waitFor(() => [...app.index.values()].length, (n) => n === 6);
    assertEquals(
      native.reads(),
      0,
      "no welcomed viewer means no optional acquisition",
    );
    await client.connect();
    const actions = [
      () => client.rpc("prefs.get", {}),
      () => client.rpc("layout.patch", {}),
      async () => {
        client.lease({ directory: "/idle", crumbs: [], rows: [] });
        await client.rpc("prefs.get", {});
      },
      () => {
        client.send({ t: "request.resume", items: [] });
      },
      () => {
        client.send({ t: "request.release", refs: [] });
      },
      async () => {
        const response = await fetch(url + "/api/session");
        await response.text();
      },
      async () => {
        const response = await fetch(url + "/");
        await response.text();
      },
    ];
    for (let i = 0; i < 3; i++) {
      for (const action of actions) {
        await action();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assertEquals(
          native.reads(),
          0,
          "requests more frequent than idlems must admit no idle batch",
        );
      }
    }
    native.emit("session.status", {
      sessionID: "ses_idle0",
      status: { type: "busy" },
    });
    await waitFor(
      () => app.index.getMetadata("opcv1-ses_idle0")?.status,
      (s) => s === "busy",
    );
    assertEquals(
      native.reads(),
      0,
      "lamp activity cannot bypass idle for header work",
    );
    const passive = setInterval(() => {
      client.send({ t: "pong" });
      client.send({ t: "request.received", refs: [] });
    }, 30);
    try {
      await waitFor(native.reads, (n) => n === 1);
    } finally {
      clearInterval(passive);
    }
    await client.rpc("prefs.get", {});
    native.release();
    for (let i = 0; i < 4; i++) {
      await client.rpc("layout.patch", {});
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(
        native.reads(),
        1,
        "admitted chunk drains; its successor waits for idle",
      );
    }
    await waitFor(
      () => [...app.index.values()].every((e) => e.digest.state === "ready"),
      Boolean,
    );
    assert(native.reads() > 1);
    console.info("Q2 IDLE PROOF", {
      activeRequests: actions.length * 3 + 5,
      optionalDuringRequests: 0,
      firstChunkReads: 1,
      finalReads: native.reads(),
      parallel: native.settings.digest.parallel,
    });
  } finally {
    native.release();
    await client.close();
    await app.stop();
  }
});

for (const background of [false, true]) {
  test(`@load @transport @attention disconnected background=${background} preserves lamp facts and controls optional backfill`, async () => {
    const native = await nativeFixture();
    native.settings.digest.background = background;
    const app = await start(native.settings);
    try {
      await waitFor(() => [...app.index.values()].length, (n) => n === 6);
      native.emit("session.status", {
        sessionID: "ses_idle0",
        status: { type: "busy" },
      });
      await waitFor(
        () => app.index.getMetadata("opcv1-ses_idle0")?.status,
        (s) => s === "busy",
      );
      native.release();
      if (background) {
        await waitFor(
          () =>
            [...app.index.values()].every((e) => e.digest.state === "ready"),
          Boolean,
        );
        assert(native.reads() > 0);
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, native.settings.digest.idlems + 50)
        );
        assertEquals(native.reads(), 0);
      }
      native.emit("session.status", {
        sessionID: "ses_idle0",
        status: { type: "idle" },
      });
      await waitFor(
        () => app.index.getMetadata("opcv1-ses_idle0")?.status,
        (s) => s === "idle",
      );
      console.info("Q2 DISCONNECTED PROOF", {
        background,
        optionalReads: native.reads(),
        lamp: app.index.getMetadata("opcv1-ses_idle0")?.status,
      });
    } finally {
      native.release();
      await app.stop();
    }
  });
}
