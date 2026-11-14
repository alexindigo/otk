// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type DigestPort, SessionIndex } from "@otk/harness";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import { DatabaseSync } from "node:sqlite";
import { SessionSupervision } from "../../core/index/supervision.ts";
import { cfg } from "../support/config.ts";
import { tempDir, test } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";
test("V2 stale work stops counting, metadata cannot revive clocks, and shutdown is not a finish", async () => {
  const root = await tempDir("supervision-adapter-");
  const index = new SessionIndex(), id = "opcv2-ses_fixture";
  let active = false, acknowledged = 50;
  const native = {
    id: "ses_fixture",
    projectID: "project",
    location: { directory: "/fixture" },
    title: "Interrupted in an earlier service lifetime",
    time: { created: 1, updated: 2, busy: 100, idle: 50 },
    outcome: "succeeded",
    slug: "fixture",
    version: "2.2.6",
    agent: "build",
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/info") {
        return Response.json({ version: "2.2.6", pid: 42 });
      }
      if (path === "/api/session/active") {
        return Response.json({
          data: active ? { ses_fixture: { type: "running" } } : {},
        });
      }
      if (path === "/api/debug/location") return Response.json([]);
      if (path === "/api/session/ses_fixture/message") {
        return Response.json({ data: [], cursor: {} });
      }
      if (path === "/api/session/ses_fixture") {
        return request.method === "GET"
          ? Response.json({ data: native })
          : new Response(null, { status: 204 });
      }
      if (path === "/api/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"type":"server.connected","data":{}}\n\n',
              ));
              request.signal.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch { /* already closed */ }
              }, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  );
  const serviceFile = root + "/service.json", settings = cfg();
  await Deno.writeTextFile(
    serviceFile,
    JSON.stringify({
      url: `http://127.0.0.1:${server.addr.port}`,
      version: "2.2.6",
      pid: 42,
    }),
  );
  const adapter = new OpencodeV2ServerAdapter({
    serviceFile,
    harness: settings.harness,
    messages: settings.messages,
  });
  const supervision = new SessionSupervision();
  const lamp = () =>
    supervision.session(index.getMetadata(id)!, acknowledged).state;
  try {
    await adapter.core.start({
      index,
      retainedSessions: [id],
      connection() {},
      indexReset() {},
      indexRemove() {},
      content() {},
      invalidate() {},
      bootstrapComplete() {},
      indexUpsert: (row) => index.upsertMetadata(row),
    });
    assertEquals(lamp(), "none");
    await adapter.capabilities.sessionActions!.rename(id, "Metadata only");
    assertEquals(lamp(), "none");
    await adapter.stream.ports.event(
      {
        type: "session.renamed",
        data: { sessionID: native.id },
        created: 2,
      },
      adapter.stream.client,
      new AbortController().signal,
      1,
    );
    assertEquals(lamp(), "none", "historical clocks are not a work inventory");
    await adapter.stream.ports.event(
      {
        type: "session.shell.ended",
        data: {
          sessionID: native.id,
          shell: { id: "shell-before-subscription" },
        },
        created: 75,
      },
      adapter.stream.client,
      new AbortController().signal,
      1,
    );
    assertEquals(
      lamp(),
      "finishedUnseen",
      "a scoped terminal is evidence even when its start was not observed",
    );
    assertEquals(index.getMetadata(id)?.activity?.work?.keys, []);
    acknowledged = 75;
    active = true;
    await adapter.stream.ports.event(
      {
        type: "session.execution.started",
        data: { sessionID: native.id },
        created: 100,
      },
      adapter.stream.client,
      new AbortController().signal,
      1,
    );
    assertEquals(lamp(), "working");
    native.time.idle = 200;
    native.outcome = "failed";
    await adapter.stream.ports.event(
      {
        type: "session.execution.failed",
        data: {
          sessionID: native.id,
          error: { message: "The usage limit has been reached" },
        },
        created: 200,
      },
      adapter.stream.client,
      new AbortController().signal,
      1,
    );
    assertEquals(
      lamp(),
      "finishedUnseen",
      "a matching terminal cannot remain working during native cleanup",
    );
    assertEquals(index.getMetadata(id)?.activity?.outcome, "failed");
    assertEquals(
      supervision.session(index.getMetadata(id)!, acknowledged).outcome,
      "failed",
    );
    acknowledged = 200;
    active = false;
    native.time.busy = 300;
    await adapter.stream.ports.event(
      {
        type: "session.execution.interrupted",
        data: { sessionID: native.id, reason: "shutdown" },
        created: 400,
      },
      adapter.stream.client,
      new AbortController().signal,
      1,
    );
    assertEquals(lamp(), "none", "shutdown loses continuity, not a terminal");
    assertEquals(index.getMetadata(id)?.activity?.terminal, 200);
    adapter.stream.ports.disconnected(1);
    assertEquals(index.getMetadata(id)?.activity?.work?.fresh, false);
    assertEquals(lamp(), "none");
  } finally {
    await adapter.core.stop();
    await server.shutdown();
  }
});

test("V1 native status owns work; disconnect and candidate absence cannot refresh it or invent a finish", async () => {
  const root = await tempDir("supervision-v1-");
  const settings = cfg(), id = "opcv1-ses_fixture", index = new SessionIndex();
  settings.harness.db = root + "/native.db";
  const db = new DatabaseSync(settings.harness.db);
  db.exec(
    "CREATE TABLE session(id TEXT,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('ses_fixture',NULL,'/fixture','p','Old terminal',1,2,NULL)",
  );
  db.prepare("INSERT INTO message VALUES('msg_old','ses_fixture',10,?)").run(
    JSON.stringify({
      role: "assistant",
      time: { created: 10, completed: 50 },
      finish: "stop",
    }),
  );
  const raw = {
    id: "ses_fixture",
    projectID: "p",
    directory: "/fixture",
    title: "Old terminal",
    time: { created: 1, updated: 2 },
  };
  let stream!: ReadableStreamDefaultController<Uint8Array>, boots = 0;
  const inventoryReads: string[] = [];
  let holdHealth = false;
  const release = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (["/session/status", "/permission", "/question"].includes(path)) {
        inventoryReads.push(path);
      }
      if (path === "/global/health") {
        if (holdHealth) await release.promise;
        return Response.json({ healthy: true, version: "1.19.3" });
      }
      if (path === "/experimental/session") return Response.json([raw]);
      if (path === "/session/status") return Response.json({});
      if (path === "/permission" || path === "/question") {
        return Response.json(
          [],
        );
      }
      if (path === "/global/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                ),
              );
              request.signal.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch { /* already closed */ }
              }, { once: true });
            },
          }),
        );
      }
      return new Response(null, { status: 404 });
    },
  );
  settings.harness.url = `http://127.0.0.1:${server.addr.port}`;
  const adapter = new OpencodeV1Adapter(settings);
  const owner = new SessionSupervision();
  const lamp = () => owner.session(index.getMetadata(id)!, 50).state;
  const emit = (type: string, properties: unknown) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            directory: "/fixture",
            payload: { type, properties },
          })
        }\n\n`,
      ),
    );
  try {
    await adapter.core.start({
      index,
      connection() {},
      indexReset: (rows) => index.resetMetadata(rows),
      indexUpsert: (row) => index.upsertMetadata(row),
      indexRemove() {},
      content() {},
      invalidate() {},
      bootstrapComplete() {
        boots++;
      },
    });
    await waitFor(() => boots, (n) => n === 1);
    assertEquals(lamp(), "none");
    assertEquals(
      owner.session(index.getMetadata(id)!, 0).state,
      "finishedUnseen",
    );
    assertEquals(
      inventoryReads,
      [],
      "Durable terminal history is not live directory demand",
    );
    emit("session.status", { sessionID: raw.id, status: { type: "busy" } });
    await waitFor(lamp, (state) => state === "working");
    emit("message.updated", {
      info: {
        id: "msg_intermediate",
        sessionID: raw.id,
        role: "assistant",
        agent: "build",
        time: { created: 100, completed: 200 },
        finish: "tool-calls",
      },
    });
    holdHealth = true;
    stream.close();
    await waitFor(
      () => index.getMetadata(id)?.activity?.work?.fresh,
      (fresh) => fresh === false,
    );
    assertEquals(lamp(), "none");
    release.resolve();
    await waitFor(() => boots, (n) => n === 2);
    assertEquals(lamp(), "none");
    emit("session.updated", {
      info: { ...raw, title: "Rename after reconnect" },
    });
    await waitFor(
      () => index.getMetadata(id)?.title,
      (title) => title === "Rename after reconnect",
    );
    assertEquals(lamp(), "none");
    assertEquals(index.getMetadata(id)?.activity?.terminal, 50);
  } finally {
    release.resolve();
    await adapter.core.stop();
    await server.shutdown();
    db.close();
  }
});

test("V2 a shell ending before its owner snapshot is still imported as terminal history", async () => {
  const root = await tempDir("supervision-snapshot-");
  const index = new SessionIndex();
  let shellSnapshot = false;
  const row = {
    id: "opcv2-ses_finished",
    directory: "/fixture",
    projectID: "p",
    title: "Finished during bootstrap",
    timeCreated: 1,
    timeUpdated: 200,
    archived: false,
    status: "idle" as const,
    activity: { terminal: 200 },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const digest: DigestPort = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    projects: () => Promise.resolve({ projects: [] }),
    catalog: () => Promise.reject(new Error("No ordinary catalog demand")),
    read: ((kind, input) => {
      assertEquals(kind, "supervision.terminals");
      return Promise.resolve(
        shellSnapshot && !(input as { after: string }).after ? [row] : [],
      );
    }) as DigestPort["read"],
    detail: () => Promise.reject(new Error("No usage demand")),
    transcriptMetadata: () => Promise.reject(new Error("No body demand")),
    observe() {},
    scope() {},
    release() {},
    deleted: () => Promise.resolve(),
    deleteIntent: () => Promise.resolve(),
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/info") {
        return Response.json({
          version: "2.2.6",
          pid: 42,
        });
      }
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/debug/location") {
        return Response.json([{
          directory: "/fixture",
        }]);
      }
      if (path === "/api/shell") {
        // The shell existed before subscription, but finishes before this read.
        // There is no owned start identity and this complete inventory is empty.
        shellSnapshot = true;
        return Response.json({ location: { directory: "/fixture" }, data: [] });
      }
      if (
        path === "/api/permission/request" || path === "/api/form"
      ) {
        return Response.json({
          location: { directory: "/fixture" },
          data: [],
        });
      }
      if (path === "/api/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"server.connected","data":{}}\n\n',
                ),
              );
              request.signal.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch { /* already closed */ }
              }, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  );
  const serviceFile = root + "/service.json", settings = cfg();
  await Deno.writeTextFile(
    serviceFile,
    JSON.stringify({
      url: `http://127.0.0.1:${server.addr.port}`,
      version: "2.2.6",
      pid: 42,
    }),
  );
  const adapter = new OpencodeV2ServerAdapter(
    { serviceFile, harness: settings.harness, messages: settings.messages },
    undefined,
    () => {},
    fetch,
    digest,
  );
  try {
    await adapter.core.start({
      index,
      connection() {},
      indexReset() {},
      indexRemove() {},
      content() {},
      invalidate() {},
      bootstrapComplete() {},
      indexUpsert: (entry) => index.upsertMetadata(entry),
    });
    assertEquals(shellSnapshot, true);
    assertEquals(index.getMetadata(row.id)?.activity?.terminal, 200);
    assertEquals(
      new SessionSupervision().session(index.getMetadata(row.id)!, 0).state,
      "finishedUnseen",
    );
  } finally {
    await adapter.core.stop();
    await server.shutdown();
  }
});
