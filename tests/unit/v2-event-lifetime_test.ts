// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { cfg } from "../support/config.ts";

Deno.test("V2 buffered deletion uses its event lifetime before stream readiness", async () => {
  const root = await Deno.makeTempDir(), diagnostics: unknown[] = [];
  const index = new SessionIndex(), id = "opcv2-ses_deleted";
  index.upsertMetadata({
    id,
    projectID: "project",
    archived: false,
    directory: root,
    title: "Deleted during bootstrap",
    timeCreated: 1,
    timeUpdated: 1,
    status: "idle",
    activityAuthority: "current",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  let connections = 0;
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
      if (path === "/api/debug/location") return Response.json([]);
      if (path === "/api/event") {
        connections++;
        return new Response(
          new ReadableStream({
            start(controller) {
              const events = [
                {
                  id: "connected-" + connections,
                  type: "server.connected",
                  data: {},
                },
                ...(connections === 1
                  ? [{
                    id: "deleted",
                    type: "session.deleted",
                    data: { sessionID: "ses_deleted" },
                  }]
                  : []),
              ];
              controller.enqueue(new TextEncoder().encode(
                events.map((event) => "data: " + JSON.stringify(event) + "\n\n")
                  .join(""),
              ));
              request.signal.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch {
                  // The reader may already have canceled this fixture stream.
                }
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
    (error) => diagnostics.push(error),
  );
  try {
    await adapter.core.start({
      index,
      connection() {},
      indexReset: (rows) => index.resetMetadata(rows),
      indexUpsert: (row) => index.upsertMetadata(row),
      indexRemove: (key) => index.remove(key),
      content() {},
      bootstrapComplete() {},
      invalidate() {},
    });
    assertEquals({
      connections,
      diagnostics: diagnostics.map(String),
      deleted: index.getMetadata(id),
    }, { connections: 1, diagnostics: [], deleted: undefined });
  } finally {
    await adapter.core.stop();
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
