// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { envelopeType } from "../envelope.ts";
import { consumeEvents } from "../events.ts";

Deno.test("envelope selector uses root payload.type with escaped keys, arbitrary order and duplicate-key semantics", () => {
  for (
    const raw of [
      '{"directory":"escaped \\"payload\\": text","payload":{"id":"event","type":"sync","syncEvent":{"type":"message.part.updated"}}}',
      '{"payload":{"properties":{"text":"nested \\"type\\": test","type":"wrong"},"type":"message.part.updated"}}',
      '{"\\u0070ayload":{"\\u0074ype":"server.connected"}}',
      '{"payload":{"type":"sync"},"payload":{"type":"message.updated"}}',
      '{"payload":{"type":"sync","type":"message.part.delta"}}',
      '{"other":[{"payload":{"type":"wrong"}}],"payload":{"type":"server.heartbeat"}}',
      JSON.stringify({
        payload: {
          properties: { text: "x".repeat(2 * 1024 * 1024) },
          type: "sync",
        },
      }),
    ]
  ) assertEquals(envelopeType(raw), JSON.parse(raw).payload.type);
  for (const raw of ["null", "[]", "{", '{"payload":{"type":1}}']) {
    assertEquals(envelopeType(raw), undefined);
  }
});

Deno.test("SSE rejects unsupported envelopes before forwarding content and retains accepted event order", async () => {
  const received: string[] = [], rejected: string[] = [];
  const types = ["server.connected", "sync", "message.part.updated"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const type of types) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${
              JSON.stringify({
                payload: {
                  type,
                  properties: {
                    text: type === "sync"
                      ? "x".repeat(2 * 1024 * 1024)
                      : "small",
                  },
                },
              })
            }\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  await consumeEvents(new Response(stream), () => {}, (event) => {
    received.push(event.payload.type);
  }, (type) => {
    if (type !== "sync") return true;
    rejected.push(type);
    return false;
  });
  assertEquals(received, ["server.connected", "message.part.updated"]);
  assertEquals(rejected, ["sync"]);
});
