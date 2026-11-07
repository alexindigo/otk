// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "../support/config.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";
import { DatabaseSync } from "node:sqlite";
import type { SessionListPage } from "@otk/protocol";
import type { DigestPressure } from "../../core/digest/protocol.ts";

async function nativeFixture(population = 6, sql = false) {
  const root = await tempDir("demand-idle-");
  const sessions = Array.from({ length: population }, (_, i) => ({
    id: `ses_idle${i}`,
    projectID: "idle",
    directory: "/idle",
    title: `Idle ${i}`,
    time: { created: 1, updated: Date.now() - i },
  }));
  const file = join(root, "native.db");
  const db = sql ? new DatabaseSync(file) : undefined;
  if (db) {
    db.exec(
      "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT); CREATE INDEX session_list ON session(directory,time_updated DESC,id DESC)",
    );
    const insert = db.prepare(
      "INSERT INTO session VALUES(?,NULL,?,?,?,?,?,NULL)",
    );
    db.exec("BEGIN");
    for (const session of sessions) {
      insert.run(
        session.id,
        session.directory,
        session.projectID,
        session.title,
        session.time.created,
        session.time.updated,
      );
    }
    db.exec("COMMIT");
    resources().defer("list source database", () => db.close());
  }
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
      if (path === "/experimental/session") {
        const limit = Number(url.searchParams.get("limit") ?? 200);
        return Response.json(sessions.slice(0, limit));
      }
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
  settings.harness.db = sql ? file : join(root, "absent.db");
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
    db,
    reads: () => reads,
    emit,
    release() {
      hold = false;
      release.resolve();
    },
  };
}

test("@load @sessions @transport project demand returns 20 of 500, bounded SQL independent of unrelated growth, then exactly one idle high-priority successor", async () => {
  const native = await nativeFixture(500, true);
  native.settings.digest = {
    ...native.settings.digest,
    batch: 100,
    idlems: 2000,
    publishrows: 20,
  };
  const samples: DigestPressure[] = [];
  const app = await start(native.settings, {
    section() {},
    pressure: (value) => samples.push(value),
  });
  const client = new WsClient(`http://127.0.0.1:${app.server.addr.port}`);
  try {
    await client.connect("/idle");
    await waitFor(
      () => app.connections.harnessState,
      (state) => state === "connected",
    );
    const page = await client.rpc<SessionListPage>("sessions.list", {
      directory: "/idle",
    });
    assertEquals(page.items.length, 20);
    assertEquals(page.load.state, "complete");
    assertEquals(page.load.boundary, { kind: "page", limit: 20 });
    assert(page.older);
    const chunk = client.frames.find((frame) => frame.t === "load.chunk");
    assert(chunk?.t === "load.chunk");
    assertEquals(chunk.load.state, "loading");
    assertEquals(chunk.data.items, []);
    const reads = () => samples.at(-1)?.nativeReads?.["session-list"] ?? 0;
    await waitFor(reads, (value) => value >= 1);
    await waitFor(reads, (value) => value === 2);
    const second = await client.rpc<SessionListPage>("sessions.list", {
      directory: "/idle",
      before: page.older,
    });
    assertEquals(second.items.length, 20);
    assertEquals(
      new Set([...page.items, ...second.items].map((item) => item.id)).size,
      40,
    );
    assertEquals(
      reads(),
      2,
      "consuming the idle-prefetched page 2 performs zero list-row reads",
    );
    const insert = native.db!.prepare(
      "INSERT INTO session VALUES(?,NULL,'/unrelated','other','Other',1,2,NULL)",
    );
    native.db!.exec("BEGIN");
    for (let i = 0; i < 5000; i++) insert.run(`unrelated_${i}`);
    native.db!.exec("COMMIT");
    const filtered = await client.rpc<SessionListPage>("sessions.list", {
      directory: "/idle",
      query: "Idle",
    });
    assertEquals(
      filtered.items.map((item) => item.id),
      page.items.map((item) => item.id),
    );
    await waitFor(reads, (value) => value >= 3);
    // Consuming page 2 admits page 3; the second query admits only its own page 2.
    await waitFor(reads, (value) => value === 5);
    const before = reads();
    assertEquals(second.load.state, "complete");
    const remembered = await client.rpc<{ id: string; directory: string }[]>(
      "sessions.identities",
      { ids: ["opcv1-ses_idle499"] },
    );
    assertEquals(remembered, [{ id: "opcv1-ses_idle499", directory: "/idle" }]);
    assertEquals(reads(), before, "point validation never enumerates a list");
    console.info(
      JSON.stringify({
        q3: {
          population: 500,
          unrelated: 5000,
          pageSize: page.items.length,
          boundedListQueries: before,
          page2NativeReads: 0,
        },
      }),
    );
  } finally {
    await client.close();
    await app.stop();
  }
});

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
