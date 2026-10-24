// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { resources, test } from "../../../tests/support/resources.ts";
import { cfg } from "../../../tests/support/config.ts";
import { Opencode1Adapter } from "../adapter.ts";

test("healthy SSE heartbeats remain observable while bootstrap reads are held", async () => {
  const root = await resources().tempDir("beats-"), settings = cfg();
  settings.harness.db = root + "/missing.db";
  settings.harness.heartbeattimeout = 0.2;
  const held = Promise.withResolvers<void>(),
    produced = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setInterval> | undefined,
    aborted = false,
    beats = 0;
  const adapter = new Opencode1Adapter(
    settings,
    undefined,
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") return Response.json({ version: "1" });
      if (path === "/experimental/session") {
        await held.promise;
        return Response.json([]);
      }
      assertEquals(path, "/global/event");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (type: string) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${
                    JSON.stringify({ payload: { type, properties: {} } })
                  }\n\n`,
                ),
              );
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              clearInterval(timer);
              controller.close();
              produced.resolve();
            }, { once: true });
            send("server.connected");
            timer = setInterval(() => {
              send("server.heartbeat");
              if (++beats === 30) {
                held.resolve();
                produced.resolve();
              }
            }, 10);
          },
          cancel() {
            clearInterval(timer);
          },
        }),
      );
    },
  );
  try {
    await adapter.core.start({
      connection() {},
      indexReset() {},
      indexUpsert() {},
      indexRemove() {},
      content() {},
      resync: () => ready.resolve(),
    });
    await produced.promise;
    assertEquals(
      aborted,
      false,
      "Backpressure hid healthy heartbeats and retired bootstrap",
    );
    assertEquals(beats >= 30, true);
    await ready.promise;
  } finally {
    clearInterval(timer);
    held.resolve();
    await adapter.core.stop();
  }
});
for (
  const scenario of [
    { name: "count", total: 512, padding: 0, limit: 129 },
    { name: "text", total: 50, padding: 200_000, limit: 12 },
  ]
) {
  test(`bootstrap staging bounds ${scenario.name} demand and replays every event in order`, async () => {
    const root = await resources().tempDir("window-"), settings = cfg();
    settings.harness.db = root + "/missing.db";
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      delivered = Promise.withResolvers<void>();
    let sent = 0;
    const seen: number[] = [], padding = "x".repeat(scenario.padding);
    const adapter = new Opencode1Adapter(
      settings,
      undefined,
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/global/health") return Response.json({ version: "1" });
        if (path === "/experimental/session") {
          entered.resolve();
          await held.promise;
          return Response.json([{
            id: "root",
            projectID: "p",
            directory: "/project",
            title: "Root",
            time: { created: 1, updated: 2 },
          }]);
        }
        if (path === "/session/status") return Response.json({});
        if (path === "/permission" || path === "/question") {
          return Response.json([]);
        }
        assertEquals(path, "/global/event");
        const bytes = (type: string, properties: object) =>
          new TextEncoder().encode(
            `data: ${JSON.stringify({ payload: { type, properties } })}\n\n`,
          );
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
              controller.enqueue(bytes("server.connected", {}));
            },
            pull(controller) {
              if (sent === scenario.total) return;
              const attempt = ++sent;
              controller.enqueue(
                bytes("session.status", {
                  sessionID: "root",
                  status: {
                    type: "retry",
                    attempt,
                    message: "Retry",
                    next: attempt,
                  },
                  padding,
                }),
              );
            },
          }, { highWaterMark: 0 }),
        );
      },
    );
    try {
      await adapter.core.start({
        connection() {},
        indexReset() {},
        indexUpsert(entry) {
          if (entry.retry) seen.push(entry.retry.attempt);
          if (seen.length === scenario.total) delivered.resolve();
        },
        indexRemove() {},
        content() {},
        resync() {},
      });
      await entered.promise;
      // All producer pulls are synchronous. A turn acknowledges drainage of
      // their microtask queue, not an elapsed-time guess for external I/O.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assertEquals(sent > 0, true, "Ordinary staging never admitted an event");
      assertEquals(
        sent <= scenario.limit,
        true,
        `Unbounded ${scenario.name} staging pulled ${sent} events`,
      );
      held.resolve();
      await delivered.promise;
      assertEquals(
        seen,
        Array.from({ length: scenario.total }, (_, n) => n + 1),
      );
    } finally {
      held.resolve();
      await adapter.core.stop();
    }
  });
}
