// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { consumeEvents } from "../events.ts";

Deno.test("SSE waits for its consumer before delivering the next event", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: string[] = [];
  const text = ["first", "second", "third"].map((type) =>
    `data: ${JSON.stringify({ payload: { type, properties: {} } })}\n\n`
  ).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const reading = consumeEvents(
    new Response(stream),
    () => {},
    async (event) => {
      received.push(event.payload.type);
      if (received.length === 1) await blocked;
    },
  );
  let beforeRelease: string[];
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    beforeRelease = [...received];
  } finally {
    release();
    await reading;
  }
  assertEquals(beforeRelease, ["first"]);
  assertEquals(received, ["first", "second", "third"]);
});
