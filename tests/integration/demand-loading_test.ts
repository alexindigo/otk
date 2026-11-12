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
import { DigestBridge } from "../../core/digest/bridge.ts";
import { sessionListReadCodec } from "@otk/harness";
import { coreBackendFixture } from "../support/core-backend.ts";
import {
  OpencodeV1Adapter,
  opencodeV1ReadCodecs,
} from "@otk/harness-opencode-v1";
import { StreamBuffers } from "@otk/content";

test("@load @messages @transport idle prefetch serves the next older batch with zero native HTTP or SQL reads", async () => {
  const native = await nativeFixture(1, true, 30);
  native.settings.messages.prefetchms = 1000;
  native.release();
  const insert = native.db!.prepare(
    "INSERT INTO message(id,session_id,data) VALUES(?,?,?)",
  );
  for (let i = 0; i < 30; i++) {
    insert.run(
      `msg_${String(i).padStart(3, "0")}`,
      "ses_idle0",
      JSON.stringify({ role: "user", time: { created: i + 1 } }),
    );
  }
  const errors: string[] = [], samples: DigestPressure[] = [];
  const bridge = new DigestBridge({
    statePath: join(native.root, "prefetch-state"),
    provider: "opencode-v1",
    reads: opencodeV1ReadCodecs,
    native: {
      harness: native.settings.harness,
      index: native.settings.index,
      attachments: native.settings.attachments,
    },
    policy: {
      ...native.settings.digest,
      idlems: 100,
      batch: 100,
      slicems: 1000,
    },
    publish() {},
    pressure: (value) => samples.push(value),
    diagnostic: (error) => errors.push(String(error)),
  });
  let metadataReads = 0;
  const observed = new Proxy(bridge, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "transcriptMetadata") {
        return (...args: Parameters<typeof bridge.transcriptMetadata>) => {
          metadataReads++;
          return bridge.transcriptMetadata(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const adapter = new OpencodeV1Adapter(
    native.settings,
    new StreamBuffers(),
    fetch,
    observed,
  );
  try {
    bridge.scope("prefetch-viewer", { sessions: [] });
    bridge.requested();
    await bridge.start();
    await bridge.projects(1, new AbortController().signal);
    const first = await adapter.core.listMessages("opcv1-ses_idle0", {});
    assertEquals(first.session.id, "opcv1-ses_idle0");
    assertEquals(
      first.items.map((m) => m.id),
      Array.from(
        { length: 10 },
        (_, i) => `msg_${String(i + 20).padStart(3, "0")}`,
      ),
    );
    await waitFor(() => native.reads(), (n) => n === 2);
    // A following essential read joins all prior bounded native/metadata work.
    await bridge.transcriptMetadata(
      "opcv1-ses_idle0",
      [],
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    bridge.requested();
    const before = native.reads();
    const httpBefore = [...native.requests];
    const metadataBefore = metadataReads;
    const sqlBefore = JSON.stringify(samples.at(-1)?.nativeReads);
    const second = await adapter.core.listMessages("opcv1-ses_idle0", {
      before: first.older!,
    });
    assertEquals(
      second.items.map((m) => m.id),
      Array.from(
        { length: 10 },
        (_, i) => `msg_${String(i + 10).padStart(3, "0")}`,
      ),
    );
    assertEquals(native.reads(), before);
    assertEquals([...native.requests], httpBefore);
    assertEquals(
      metadataReads,
      metadataBefore,
      "cached scalar metadata must skip the worker SQL read",
    );
    assertEquals(JSON.stringify(samples.at(-1)?.nativeReads), sqlBefore);
    assertEquals(second.prompt, first.prompt);
    assertEquals(errors, []);
    console.info("Q6: newest=10, older=10, cache-hit native HTTP=0, SQL=0");
    bridge.release("prefetch-viewer");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const expiredBefore = native.reads();
    const expired = await adapter.core.listMessages("opcv1-ses_idle0", {
      before: first.older!,
    });
    assertEquals(expired.items.map((m) => m.id), second.items.map((m) => m.id));
    assertEquals(
      native.reads(),
      expiredBefore + 1,
      "expired entries require a fresh native batch",
    );
  } finally {
    await adapter.core.stop();
    await bridge.stop();
  }
});

test("@load @sessions @messages @transport replies complete only their requested boundary after held-source loading", async () => {
  const root = await tempDir("boundary-replies-");
  const f = await coreBackendFixture(root);
  const release = Promise.withResolvers<void>();
  resources().defer("held boundary source", () => release.resolve());
  for (const key of ["getSession", "listMessages", "listSessions"] as const) {
    const read = f.app.backend.core[key].bind(f.app.backend.core);
    f.app.backend.core[key] = (async (...args: unknown[]) => {
      await release.promise;
      return await (read as (...args: unknown[]) => unknown)(...args);
    }) as never;
  }
  const client = new WsClient(f.url);
  await client.connect(root);
  const metadata = client.rpc<import("@otk/protocol").RpcResult<"session.get">>(
    "session.get",
    { sessionID: f.session.id },
  );
  const messages = client.rpc<
    import("@otk/protocol").RpcResult<"session.messages">
  >("session.messages", { sessionID: f.session.id });
  const list = client.rpc<SessionListPage>("sessions.list", {
    directory: root,
  });
  await waitFor(
    () => client.frames.filter((frame) => frame.t === "load.chunk").length,
    (count) => count === 3,
  );
  const loading = client.frames.filter((frame) => frame.t === "load.chunk");
  assertEquals(loading.map((frame) => frame.load.state), [
    "loading",
    "loading",
    "loading",
  ]);
  assertEquals(
    client.frames.filter((frame) => frame.t === "request.result").length,
    0,
  );
  release.resolve();
  const replies = await Promise.all([metadata, messages, list]);
  for (const reply of replies) {
    const first = loading.find((frame) => frame.load.id === reply.load.id)!;
    assert(first);
    assertEquals(reply.load.state, "complete");
    assertEquals(reply.load.scope, first.load.scope);
    assertEquals(reply.load.boundary, first.load.boundary);
    assert(reply.load.revision > first.load.revision);
  }
  assertEquals(replies[1].items[0].id, "message");
});

async function nativeFixture(
  population = 6,
  sql = false,
  messageCount?: number,
) {
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
      "CREATE TABLE project(id TEXT PRIMARY KEY,worktree TEXT); INSERT INTO project VALUES('idle','/idle'); CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT); CREATE INDEX session_list ON session(directory,time_updated DESC,id DESC)",
    );
    const insert = db.prepare(
      // Match native collection ordering without changing fixture insert shapes.
      "INSERT INTO session VALUES(?,NULL,?,?,?,?,?,NULL)",
    );
    db.exec(
      "ALTER TABLE message ADD COLUMN time_created INTEGER GENERATED ALWAYS AS (json_extract(data,'$.time.created')) VIRTUAL; CREATE INDEX message_order ON message(session_id,time_created,id)",
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
  const requests = new Map<string, number>();
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
      requests.set(path, (requests.get(path) ?? 0) + 1);
      if (path === "/project") {
        return Response.json([{ id: "idle", worktree: "/idle" }]);
      }
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
        if (messageCount !== undefined) {
          const end = Number(url.searchParams.get("before") ?? messageCount),
            limit = Number(url.searchParams.get("limit"));
          const begin = Math.max(0, end - limit);
          return Response.json(
            Array.from(
              { length: end - begin },
              (_, i) => ({
                info: {
                  id: `msg_${String(begin + i).padStart(3, "0")}`,
                  sessionID: session.id,
                  role: "user",
                  time: { created: begin + i + 1 },
                },
                parts: [],
              }),
            ),
            { headers: begin ? { "x-next-cursor": String(begin) } : {} },
          );
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
    root,
    requests,
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

test("@load @sessions @messages metadata demand stops newest-first at its boundary, extends older, drains high then normal then source discovery", async () => {
  const native = await nativeFixture(5, true);
  const source = native.db!;
  source.exec("UPDATE session SET directory='/other' WHERE id='ses_idle3'");
  source.exec("UPDATE session SET directory='/inactive' WHERE id='ses_idle4'");
  const insert = source.prepare(
    "INSERT INTO message(id,session_id,data) VALUES(?,?,?)",
  );
  for (let i = 0; i < 8; i++) {
    insert.run(
      `msg_${i}`,
      "ses_idle0",
      JSON.stringify({
        role: "assistant",
        parentID: "prompt",
        providerID: "fake",
        modelID: "scripted",
        time: { created: i + 1, completed: i + 2 },
        cost: .25,
        tokens: {
          input: 1,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    );
  }
  for (let i = 1; i < 5; i++) {
    insert.run(
      `other_${i}`,
      `ses_idle${i}`,
      JSON.stringify({ role: "user", time: { created: 1 } }),
    );
  }
  const statePath = join(native.root, "cursor-state");
  const publications: { id: string; count?: number; ready: boolean }[] = [];
  const samples: DigestPressure[] = [], errors: string[] = [];
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    reads: { "sessions.list": sessionListReadCodec },
    native: {
      harness: native.settings.harness,
      index: native.settings.index,
      attachments: native.settings.attachments,
    },
    policy: {
      ...native.settings.digest,
      idlems: 1500,
      parallel: 1,
      batch: 2,
      slicems: 1000,
    },
    publish: (value) =>
      publications.push({
        id: value.sessionID,
        count: value.delta.summary.messageCount,
        ready: value.delta.summary.state === "ready",
      }),
    pressure: (value) => samples.push(value),
    diagnostic: (error) => errors.push(String(error)),
  });
  let derived: DatabaseSync | undefined;
  try {
    bridge.discoveryProject("/inactive", false);
    bridge.scope("cursor-viewer", { sessions: [] });
    bridge.requested();
    await bridge.start();
    await bridge.projects(1, new AbortController().signal);
    const signal = new AbortController().signal;
    await bridge.transcriptMetadata("opcv1-ses_idle0", [], signal, undefined, {
      messageID: "msg_5",
      created: 6,
    });
    derived = new DatabaseSync(join(statePath, "digest.db"), {
      readOnly: true,
    });
    const messages = () =>
      derived!.prepare(
        "SELECT message_id FROM opcv1_messages WHERE session_id='opcv1-ses_idle0' ORDER BY time_created DESC,message_id DESC",
      ).all().map((r) => r.message_id);
    assertEquals(messages(), ["msg_7", "msg_6", "msg_5"]);
    assertEquals(
      derived.prepare(
        "SELECT state FROM digest_sessions WHERE id='opcv1-ses_idle0'",
      ).get()?.state,
      "digesting",
    );
    bridge.requested();
    await bridge.transcriptMetadata("opcv1-ses_idle0", [], signal, undefined, {
      messageID: "msg_3",
      created: 4,
    });
    assertEquals(messages(), ["msg_7", "msg_6", "msg_5", "msg_4", "msg_3"]);
    assertEquals(
      derived.prepare(
        "SELECT complete_revision FROM opcv1_scan WHERE session_id='opcv1-ses_idle0'",
      ).get()?.complete_revision,
      null,
    );
    await bridge.read("sessions.list", {
      directory: "/idle",
      query: "Idle 1",
      limit: 1,
    }, { owner: "normal-list", priority: "user", signal });
    await waitFor(
      () =>
        publications.filter((p) => p.id === "opcv1-ses_idle0").at(-1)?.count,
      (value) => value === 5,
    );
    assertEquals(samples.at(-1)?.nativeReads?.["session-discovery"] ?? 0, 0);
    const beforeIdle = publications.length;
    await waitFor(
      () => publications.filter((p) => p.ready).map((p) => p.id),
      (ids) => new Set(ids).size === 4,
    );
    const ready = [
      ...new Set(publications.filter((p) => p.ready).map((p) => p.id)),
    ];
    assertEquals(ready.slice(0, 2), ["opcv1-ses_idle0", "opcv1-ses_idle1"]);
    const highChunks = publications.slice(beforeIdle).filter((p) =>
      p.id === "opcv1-ses_idle0" && p.count !== undefined
    );
    assertEquals(highChunks.map((p) => p.count), [7, 8]);
    await waitFor(() => samples.at(-1)?.queued, (value) => value === 0);
    assertEquals(errors, []);
    assertEquals(messages().length, 8);
    assertEquals(
      derived.prepare(
        "SELECT 1 FROM digest_sessions WHERE id='opcv1-ses_idle4'",
      ).get(),
      undefined,
    );
    console.log(
      JSON.stringify({
        requested: 3,
        extended: 5,
        idleChunks: highChunks.map((p) => p.count),
        readyOrder: ready,
        sourceSlices: samples.at(-1)?.nativeReads?.["session-discovery"],
      }),
    );
  } finally {
    derived?.close();
    await bridge.stop();
  }
});

test("@load @sessions @attention project-only cold and warm startup seeds an untracked Active project and 130 lamp-free templates without population reads", async () => {
  const native = await nativeFixture(1, true);
  native.settings.digest.idlems = 60000;
  const templates = join(native.root, "templates");
  await Deno.mkdir(templates);
  for (let i = 0; i < 130; i++) await Deno.mkdir(join(templates, `empty-${i}`));
  let samples: DigestPressure[] = [];
  let app = await start(native.settings, {
    section() {},
    pressure: (value) => samples.push(value),
  });
  let client = new WsClient(`http://127.0.0.1:${app.server.addr.port}`);
  const snapshot = async () =>
    (await client.rpc<import("@otk/protocol").InboxBaseline>("inbox.get", {}))
      .inbox;
  const noPopulation = () => {
    assertEquals(native.requests.get("/experimental/session") ?? 0, 0);
    assertEquals(native.reads(), 0);
    for (const key of ["catalog", "empty", "headers", "helpers", "tools"]) {
      assertEquals(samples.at(-1)?.nativeReads?.[key] ?? 0, 0, key);
    }
  };
  try {
    await client.connect();
    await waitFor(
      () => app.connections.harnessState,
      (value) => value === "connected",
    );
    await client.rpc("projects.templates", {
      templates: [templates + "/{project}"],
    });
    await waitFor(snapshot, (value) => value.discovered?.length === 130);
    const first = await snapshot();
    // Topology is now additive; scalar authority and no-population reads stay exact.
    const direct: import("@otk/protocol").ProjectSummary = {
      directory: "/idle",
      hasSessions: true,
      status: "none",
      sessionCount: 1,
      unseenCount: 0,
      lastActivity: Number(
        native.db!.prepare("SELECT time_updated FROM session").get()!
          .time_updated,
      ),
      authority: "current",
      topology: {
        repoID: "idle",
        canonicalRoot: "/idle",
        leafDirectory: "/idle",
      },
      scopes: ["/idle"],
    };
    assertEquals(first.summaries?.["/idle"], { ...direct, direct });
    assertEquals(first.projects, []);
    assertEquals(
      [...app.index.values()].length,
      0,
      "ordinary sessions are not replayed",
    );
    for (const directory of first.discovered!) {
      assertEquals(first.summaries?.[directory]?.hasSessions, false);
    }
    noPopulation();
    await client.rpc("projects.inactive", {
      directory: "/idle",
      inactive: true,
    });
    assertEquals(
      (await snapshot()).projects.find((p) => p.directory === "/idle")
        ?.inactive,
      true,
    );
    native.emit("session.status", {
      sessionID: "ses_idle0",
      status: { type: "busy" },
    });
    await waitFor(
      snapshot,
      (value) =>
        value.summaries?.["/idle"]?.status === "working" &&
        !value.projects.find((p) => p.directory === "/idle")?.inactive,
    );
    native.emit("message.updated", {
      info: {
        id: "msg_finish",
        sessionID: "ses_idle0",
        role: "assistant",
        agent: "build",
        time: { created: 10, completed: 20 },
      },
    });
    native.emit("session.status", {
      sessionID: "ses_idle0",
      status: { type: "idle" },
    });
    await waitFor(
      snapshot,
      (value) => value.summaries?.["/idle"]?.status === "finished",
    );
    await client.close();
    await app.stop();
    native.requests.clear();
    samples = [];
    app = await start(native.settings, {
      section() {},
      pressure: (value) => samples.push(value),
    });
    client = new WsClient(`http://127.0.0.1:${app.server.addr.port}`);
    await client.connect();
    await waitFor(
      () => app.connections.harnessState,
      (value) => value === "connected",
    );
    assertEquals(
      (await snapshot()).summaries?.["/idle"]?.status,
      "finished",
      "never-demanded unseen work survives restart",
    );
    assertEquals(
      [...app.index.values()].length,
      1,
      "only the persisted unseen identity is retained",
    );
    noPopulation();
    await client.rpc("sessions.seen", {
      sessionID: "opcv1-ses_idle0",
      terminal: 20,
    });
    const page = await client.rpc<SessionListPage>("sessions.list", {
      directory: "/idle",
    });
    assertEquals(page.items.length, 1);
    assertEquals(
      (await snapshot()).summaries?.["/idle"]?.sessionCount,
      1,
      "keyed hydration does not add population",
    );
    await client.close();
    await app.stop();
    native.requests.clear();
    samples = [];
    app = await start(native.settings, {
      section() {},
      pressure: (value) => samples.push(value),
    });
    client = new WsClient(`http://127.0.0.1:${app.server.addr.port}`);
    await client.connect();
    await waitFor(
      () => app.connections.harnessState,
      (value) => value === "connected",
    );
    assertEquals(
      [...app.index.values()].length,
      0,
      "warm startup does not replay retained catalog",
    );
    assertEquals((await snapshot()).summaries?.["/idle"]?.hasSessions, true);
    noPopulation();
    console.info("Q1 PROOF", {
      templates: 130,
      activeProjects: 1,
      coldCatalogReads: 0,
      warmCatalogReads: 0,
      headerReads: 0,
      helperReads: 0,
      populationReplay: 0,
    });
  } finally {
    await client.close();
    await app.stop();
  }
});

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
    assert(chunk.data.kind === "session-list");
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
    // Q1 removes startup admission; demand one unfinished entry to retain this proof's single-chunk fence.
    await app.backend.core.listSessions({ directory: "/idle", limit: 1 });
    await waitFor(() => [...app.index.values()].length, (n) => n === 1);
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
        const started = performance.now();
        await action();
        await new Promise((resolve) => setTimeout(resolve, 40));
        assertEquals(
          native.reads(),
          0,
          `requests more frequent than idlems must admit no idle batch (round ${i}, action ${
            actions.indexOf(action)
          }, elapsed ${performance.now() - started}ms)`,
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
      // Q1 removes startup admission; seed this Q2 scheduling proof through explicit list demand.
      await app.backend.core.listSessions({ directory: "/idle", limit: 6 });
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
