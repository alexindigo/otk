// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir, test } from "../../../tests/support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { ContentOp } from "@otk/protocol";
import { loadServiceConfig } from "../../../core/config/loader.ts";
import { StreamBuffers } from "@otk/content";
import { Opencode1Adapter } from "../adapter.ts";
import type { Envelope, Info, RawPart, Session } from "../types.ts";

async function waitFor(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!read()) {
    assert(Date.now() < deadline, "Recorded event delivery stalled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (
  const outcome of [
    "complete part",
    "complete message",
    "last unsubscribe",
    "unsubscribed",
    "stop",
    "message removed",
    "part removed",
    "session deleted",
    "generation reset",
  ] as const
) {
  test(`adapter recorded stream buffers: ${outcome}`, async () => {
    // Recorded from the real 1.18.34 scripted provider in the named M1 guest.
    const frames: Envelope[] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../../tests/fixtures/opencode1/stream-lifecycle.json",
          import.meta.url,
        ),
      ),
    );
    const session = frames[0].payload.properties!.info as Session;
    const cfg = loadServiceConfig({
      defaultsPath: fromFileUrl(
        new URL("../../../defaults/otk.toml", import.meta.url),
      ),
      env: {},
    }).config;
    cfg.harness.db = join(await tempDir("native-buffers-"), "missing.db");
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const fetcher: typeof fetch = (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/global/health") {
        return Promise.resolve(Response.json({ version: "1.18.34" }));
      }
      if (
        url.pathname === "/experimental/session" || url.pathname === "/agent"
      ) {
        return Promise.resolve(Response.json([]));
      }
      if (url.pathname.includes("/message/")) {
        const info = frames.findLast((frame) =>
          frame.payload.type === "message.updated" &&
          (frame.payload.properties?.info as Info | undefined)?.role ===
            "assistant"
        )!.payload.properties!.info as Info;
        const parts = [
          ...new Map(
            frames.flatMap((frame) =>
              frame.payload.properties?.part
                ? [frame.payload.properties.part as RawPart]
                : []
            ).filter((part) => part.messageID === info.id).map(
              (part) => [part.id, part],
            ),
          ).values(),
        ];
        return Promise.resolve(Response.json({ info, parts }));
      }
      assertEquals(url.pathname, "/global/event");
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          options?.signal?.addEventListener("abort", () => value.close(), {
            once: true,
          });
        },
      });
      return Promise.resolve(new Response(body));
    };
    const buffers = new StreamBuffers(),
      adapter = new Opencode1Adapter(cfg, buffers, fetcher);
    const ops: ContentOp[] = [];
    let ready = false,
      barrier = 0,
      observed = 0,
      seeded = false,
      stopped = false;
    const send = (event: Envelope) =>
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
      );
    try {
      adapter.core.subscriptions(
        session.id,
        outcome === "unsubscribed" ? 0 : 2,
      );
      await adapter.core.start({
        connection: () => {},
        indexReset: () => {
          ready = true;
        },
        indexUpsert: (entry) => {
          observed = entry.retry?.attempt ?? observed;
        },
        indexRemove: () => {},
        content: (_id, op) => ops.push(op),
        resync: () => {},
      });
      await waitFor(() => !!controller);
      send({
        directory: "/project",
        payload: { type: "server.connected", properties: {} },
      });
      await waitFor(() => ready);
      for (const frame of frames) {
        const part = frame.payload.properties?.part as RawPart | undefined;
        if (outcome === "complete message" && part?.time?.end !== undefined) {
          continue;
        }
        send(frame);
        // A normal ordered status event is an external barrier for event delivery.
        barrier++;
        send({
          directory: "/project",
          payload: {
            type: "session.status",
            properties: {
              sessionID: session.id,
              status: {
                type: "retry",
                attempt: barrier,
                message: "fixture delivery",
                next: 0,
              },
            },
          },
        });
        await waitFor(() => observed === barrier);
        if (part && part.time?.start === undefined) {
          assertEquals(
            buffers.size,
            0,
            "User text is not a live assistant stream",
          );
        }
        if (part?.time?.start !== undefined && part.time.end === undefined) {
          seeded = true;
          assertEquals(buffers.size, 1);
          if (outcome === "last unsubscribe") {
            adapter.core.subscriptions(session.id, 1);
            assertEquals(buffers.size, 1);
            adapter.core.subscriptions(session.id, 0);
            assertEquals(buffers.size, 1);
          }
          if (outcome === "stop") {
            await adapter.core.stop();
            stopped = true;
            assertEquals(buffers.size, 0);
            break;
          }
          if (
            [
              "message removed",
              "part removed",
              "session deleted",
              "generation reset",
            ].includes(outcome)
          ) {
            const before = ops.length;
            send({
              directory: "/project",
              payload: {
                type: "message.part.delta",
                properties: {
                  sessionID: session.id,
                  messageID: part.messageID,
                  partID: part.id,
                  field: "text",
                  delta: " pending tail",
                },
              },
            });
            const type = outcome === "message removed"
              ? "message.removed"
              : outcome === "part removed"
              ? "message.part.removed"
              : outcome === "session deleted"
              ? "session.deleted"
              : "server.instance.disposed";
            send({
              directory: "/project",
              payload: {
                type,
                properties: {
                  sessionID: session.id,
                  messageID: part.messageID,
                  partID: part.id,
                  info: session,
                },
              },
            });
            await waitFor(() => buffers.size === 0);
            await new Promise((resolve) => setTimeout(resolve, 75));
            assertEquals(
              ops.slice(before).some((op) => op.op === "part.blocks"),
              false,
              "Removed generation published a delayed tail",
            );
            break;
          }
        }
      }
      assert(seeded, "Fixture did not contain an authoritative streaming part");
      assertEquals(buffers.size, 0);
      if (outcome === "unsubscribed") assertEquals(ops, []);
      if (outcome === "complete part" || outcome === "complete message") {
        assert(
          ops.some((op) =>
            op.op === "part.upsert" && op.part.kind === "text" &&
            JSON.stringify(op.part.blocks).includes("First second")
          ),
        );
      }
    } finally {
      if (!stopped) await adapter.core.stop();
    }
    assertEquals(buffers.size, 0);
  });
}
