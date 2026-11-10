// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { V2Stream } from "../stream.ts";

Deno.test("V2 stop cancels its owned SSE body and joins cancellation settlement", async () => {
  const cancellation = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelCalls = 0, joined = false;
  const stream = new V2Stream(
    {
      discover: () =>
        Promise.resolve({
          endpoint: { url: "http://127.0.0.1:42" },
          version: "2.2.6",
          pid: 42,
        }),
      resync: () => Promise.resolve(() => {}),
      event() {},
      connected() {},
      disconnected() {},
      diagnostic() {},
    },
    {
      requestms: 1000,
      reconnectmax: 1,
      heartbeattimeout: 45,
      replayops: 2,
      replaybytes: 1024,
    },
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              value.enqueue(new TextEncoder().encode(
                'data: {"type":"server.connected","data":{}}\n\n',
              ));
            },
            // This transport does not close its body merely because fetch aborts.
            cancel() {
              cancelCalls++;
              return cancellation.promise;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  await stream.start();
  const stopping = stream.stop().then(() => {
    joined = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(cancelCalls, 1, "the stream owns body cancellation");
    assertEquals(joined, false, "stop joins actual cancellation cleanup");
    cancellation.resolve();
    await stopping;
    assertEquals(joined, true);
  } finally {
    cancellation.resolve();
    try {
      controller.close();
    } catch { /* cancellation may already close it */ }
    await stopping;
  }
});
