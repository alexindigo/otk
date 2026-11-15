// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import { V2Client } from "../client.ts";

function held() {
  const generation = new AbortController(), lifetime = new AbortController();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const client = new V2Client(
    { endpoint: { url: "http://127.0.0.1:42" }, version: "2.2.6", pid: 42 },
    1000,
    generation.signal,
    (_input, options) => {
      calls++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              options!.signal!.addEventListener(
                "abort",
                () => controller.error(options!.signal!.reason),
                { once: true },
              );
              entered.resolve();
            },
          }),
        ),
      );
    },
    undefined,
    undefined,
    lifetime.signal,
  );
  return { client, generation, lifetime, entered, calls: () => calls };
}

for (const derived of [false, true]) {
  Deno.test(`V2 explicit ${derived ? "derived" : "same"} generation signal cannot leak its raw read-abort reason`, async () => {
    const x = held(),
      reset = new TypeError("error reading a body from connection");
    const signal = derived
      ? AbortSignal.any([x.generation.signal])
      : x.generation.signal;
    const rejected = assertRejects(
      () =>
        x.client.read(
          (api) => api.session.get({ sessionID: "ses_one" }),
          signal,
        ),
      OperationFailure,
    );
    await x.entered.promise;
    x.generation.abort(reset);
    try {
      const error = await rejected;
      assertEquals([error.outcome, error.code], [
        "unavailable",
        "native.unavailable",
      ]);
      assertStrictEquals(error.cause, reset);
      assertEquals(x.calls(), 1);
    } finally {
      await x.client.join();
    }
  });
}

Deno.test("V2 independent caller cancellation remains cancellation while its generation is current", async () => {
  const x = held(),
    caller = new AbortController(),
    reason = new DOMException("user cancelled", "AbortError");
  const rejected = assertRejects(
    () =>
      x.client.read(
        (api) => api.session.get({ sessionID: "ses_one" }),
        caller.signal,
      ),
    DOMException,
    "user cancelled",
  );
  await x.entered.promise;
  caller.abort(reason);
  assertStrictEquals(await rejected, reason);
  assertEquals(x.generation.signal.aborted, false);
  assertEquals(x.calls(), 1);
  await x.client.join();
});

Deno.test("V2 lifetime shutdown remains cancellation rather than generation unavailability", async () => {
  const x = held(), reason = new DOMException("lifetime stopped", "AbortError");
  const rejected = assertRejects(
    () => x.client.read((api) => api.session.get({ sessionID: "ses_one" })),
    DOMException,
    "lifetime stopped",
  );
  await x.entered.promise;
  x.lifetime.abort(reason);
  x.generation.abort(reason);
  assertStrictEquals(await rejected, reason);
  assertEquals(x.calls(), 1);
  await x.client.join();
});
