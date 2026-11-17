// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { cfg } from "../support/config.ts";
import { bounded, tempDir, test } from "../support/resources.ts";

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

for (const retirement of ["stop", "close"] as const) {
  test(`V2 execution facts read borrows the actual stream ${retirement} lifetime`, async () => {
    const root = await tempDir("failure-lifetime-"), settings = cfg();
    const diagnostics: unknown[] = [], index = new SessionIndex();
    const entered = Promise.withResolvers<void>(),
      aborted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let connections = 0, stream!: ReadableStreamDefaultController<Uint8Array>;
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/info") {
          return Response.json({ version: "2.2.6", pid: 42 });
        }
        if (path === "/api/session/active") {
          return Response.json({ data: {} });
        }
        if (path === "/api/debug/location") return Response.json([]);
        if (path === "/api/event") {
          connections++;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"server.connected","data":{}}\n\n',
                  ),
                );
                request.signal.addEventListener("abort", () => {
                  try {
                    controller.close();
                  } catch { /* Already retired. */ }
                }, { once: true });
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(null, { status: 404 });
      },
    );
    const serviceFile = root + "/service.json";
    await Deno.writeTextFile(
      serviceFile,
      JSON.stringify({
        url: `http://127.0.0.1:${server.addr.port}`,
        version: "2.2.6",
        pid: 42,
      }),
    );
    const adapter = new OpencodeV2ServerAdapter(
      {
        serviceFile,
        harness: settings.harness,
        messages: settings.messages,
      },
      undefined,
      (error) => diagnostics.push(error),
    );
    let factsSignal: AbortSignal | undefined;
    adapter.transcript.options.facts = (_input, signal) => {
      factsSignal = signal;
      entered.resolve();
      return new Promise((resolve, reject) => {
        release.promise.then(() =>
          resolve({
            source: "fixture",
            contexts: {},
            metadata: { boundaries: [] },
          })
        );
        signal.addEventListener("abort", () => {
          aborted.resolve();
          reject(signal.reason);
        }, { once: true });
      });
    };
    let stopping: Promise<void> | undefined;
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
      stream.enqueue(new TextEncoder().encode(
        "data: " + JSON.stringify({
          id: "evt_held_failure",
          type: "session.execution.failed",
          created: 5,
          data: {
            sessionID: "ses_failure",
            error: { type: "provider", message: "Held execution failure" },
          },
        }) + "\n\n",
      ));
      await bounded("execution facts entered", entered.promise);
      assert(factsSignal && !factsSignal.aborted);
      if (retirement === "stop") stopping = adapter.core.stop();
      else stream.close();
      await bounded(
        "stream cancellation reaches held execution facts",
        aborted.promise,
      );
      assert(factsSignal.aborted);
      const cancelledSignal = factsSignal;
      if (stopping) await bounded("joined adapter stop", stopping);
      else {
        const deadline = performance.now() + 5000;
        while (connections < 2) {
          assert(
            performance.now() < deadline,
            "Stream did not reconnect after cancelling its fact read",
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      release.resolve();
      assertEquals(
        await adapter.transcript.requests.page(
          "opcv2-ses_failure",
          undefined,
          10,
        ),
        [],
        "Retired execution cannot publish a retained failure",
      );
      assertEquals(
        index.getMetadata("opcv2-ses_failure")?.attention.error,
        undefined,
      );
      assertEquals(
        diagnostics.filter((cause) => cause === cancelledSignal.reason).length,
        retirement === "close" ? 1 : 0,
        "Only stream closure is diagnostic; cancelled facts must not add another report",
      );
    } finally {
      release.resolve();
      await bounded(
        "failed-control adapter cleanup",
        stopping ?? adapter.core.stop(),
      );
      await server.shutdown();
    }
  });
}
