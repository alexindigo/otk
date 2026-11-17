// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import {
  decodeEvent,
  type StreamPorts,
  V2_SILENCE_MS,
  type V2Event,
  V2Stream,
} from "../stream.ts";

function setup(
  overrides: Partial<StreamPorts> = {},
  budgets: { replayops?: number; replaybytes?: number } = {},
) {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const applied: V2Event[] = [],
    order: string[] = [],
    diagnostics: unknown[] = [];
  const encoder = new TextEncoder();
  const stream = new V2Stream(
    {
      discover: () =>
        Promise.resolve({
          endpoint: { url: "http://127.0.0.1:42" },
          version: "2.2.6",
          pid: 42,
        }),
      resync: () => {
        order.push("snapshot");
        return Promise.resolve(() => {
          order.push("commit");
        });
      },
      event: (event) => {
        applied.push(event);
      },
      connected: () => {
        order.push("ready");
      },
      disconnected: () => {},
      diagnostic: (error) => {
        diagnostics.push(error);
      },
      ...overrides,
    },
    {
      requestms: 1000,
      reconnectmax: 1,
      heartbeattimeout: 45,
      replayops: 2,
      replaybytes: 1024,
      ...budgets,
    },
    (_input, options) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
              order.push("subscribed");
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"server.connected","data":{}}\r\n\r\n',
                ),
              );
              options?.signal?.addEventListener("abort", () => {
                try {
                  controller.error(options.signal?.reason);
                } catch { /* already retired */ }
              }, { once: true });
            },
          }, { highWaterMark: 0 }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  );
  const send = (event: unknown, index = controllers.length - 1) =>
    controllers[index].enqueue(
      encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
    );
  return { stream, controllers, applied, order, send, diagnostics };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Stream contract timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
Deno.test("V2 backpressured dispatch owns exactly one next transport chunk and preserves event order", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const delivered: number[] = [];
  const x = setup({
    event: async (event) => {
      delivered.push(Number(event.data.order));
      if (event.data.order === 0) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    await x.stream.start();
    x.send({
      type: "session.execution.started",
      data: { sessionID: "ses_1", order: 0 },
    });
    await entered.promise;
    for (let i = 1; i <= 20; i++) {
      x.send({
        id: String(i),
        type: "session.execution.started",
        data: { sessionID: "ses_1", order: i },
      });
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEquals(delivered, [0], "Parser dispatch remains serial");
    assertEquals(
      x.controllers[0].desiredSize,
      -19,
      "Only one of twenty later chunks can be read while dispatch is held",
    );
    release.resolve();
    await until(() => delivered.length === 21);
    assertEquals(delivered, Array.from({ length: 21 }, (_, i) => i));
  } finally {
    release.resolve();
    await x.stream.stop();
  }
});

Deno.test("V2 bootstrap byte admission remains backpressured with transport read-ahead", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const x = setup({
    resync: async () => {
      entered.resolve();
      await release.promise;
      return () => {};
    },
  }, { replayops: 100, replaybytes: 64 });
  const starting = x.stream.start();
  try {
    await entered.promise;
    for (let i = 0; i < 3; i++) {
      x.send({
        id: String(i),
        type: "session.execution.started",
        data: { sessionID: "ses_1", order: i, payload: "x".repeat(100) },
      });
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEquals(x.applied, []);
    assertEquals(x.order.includes("ready"), false);
    release.resolve();
    await starting;
    await until(() => x.applied.length === 3);
    assertEquals(x.applied.map((event) => event.data.order), [0, 1, 2]);
  } finally {
    release.resolve();
    await x.stream.stop();
  }
});
Deno.test("V2 stream subscribes before snapshot and replays bounded bootstrap in order", async () => {
  const gate = Promise.withResolvers<void>();
  let snapshots = 0;
  const x = setup({
    resync: async () => {
      snapshots++;
      await gate.promise;
      return () => {};
    },
  });
  const starting = x.stream.start();
  await until(() => snapshots === 1);
  x.send({ type: "server.connected", data: {} });
  for (let i = 0; i < 5; i++) {
    x.send({
      id: String(i),
      type: "session.execution.started",
      data: { sessionID: "ses_1", order: i },
    });
  }
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(x.applied.length, 0);
  gate.resolve();
  await starting;
  await until(() => x.applied.length === 5);
  assertEquals(snapshots, 1);
  assertEquals(x.applied.map((e) => e.data.order), [0, 1, 2, 3, 4]);
  x.send({
    id: "4",
    type: "session.execution.started",
    data: { sessionID: "ses_1", order: 4 },
  });
  await x.stream.stop();
  assertEquals(x.applied.length, 5);
});
Deno.test("V2 stream reconnect re-discovers, resyncs and fences old generations", async () => {
  let generation = 0;
  const x = setup({
    discover: () => {
      generation++;
      return Promise.resolve({
        endpoint: { url: "http://127.0.0.1:42" },
        pid: generation,
        version: "2.2.6",
      });
    },
  });
  await x.stream.start();
  assertEquals(x.order, ["subscribed", "snapshot", "commit", "ready"]);
  x.controllers[0].error(new Error("deliberate disconnect"));
  await until(() => x.order.filter((e) => e === "ready").length === 2);
  assertEquals(generation, 2);
  assertEquals(x.order, [
    "subscribed",
    "snapshot",
    "commit",
    "ready",
    "subscribed",
    "snapshot",
    "commit",
    "ready",
  ]);
  await x.stream.stop();
});

Deno.test("V2 mid-body reset is caught by the stream loop and reconnects", async () => {
  const disconnected: number[] = [];
  const x = setup({
    disconnected: (generation) => disconnected.push(generation),
  });
  try {
    await x.stream.start();
    const client = x.stream.client;
    const reset = new TypeError("error reading a body from connection");
    x.controllers[0].enqueue(new TextEncoder().encode('data: {"type":'));
    x.controllers[0].error(reset);
    await until(() => disconnected.length === 1);
    assertEquals(client.signal.aborted, true);
    assertEquals(x.diagnostics, [reset]);
    await until(() =>
      x.order.filter((event) => event === "ready").length === 2
    );
    x.send({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    await until(() => x.applied.length === 1);
    assertEquals(disconnected, [1]);
  } finally {
    await x.stream.stop();
  }
});

Deno.test("V2 body-read failure retires concurrent reads as unavailable, not a raw transport throw", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const x = setup();
  try {
    await x.stream.start();
    const reading = x.stream.client.read(async () => {
      entered.resolve();
      await release.promise;
      return "late native result";
    });
    const rejected = assertRejects(() => reading, OperationFailure);
    await entered.promise;
    x.controllers[0].enqueue(new TextEncoder().encode('data: {"type":'));
    x.controllers[0].error(
      new TypeError("error reading a body from connection"),
    );
    await until(() => x.diagnostics.length === 1);
    release.resolve();
    const error = await rejected;
    assertEquals(error.outcome, "unavailable");
    assertEquals(error.code, "native.unavailable");
  } finally {
    release.resolve();
    await x.stream.stop();
  }
});
Deno.test("V2 stream stop joins bootstrap and drops its late commit", async () => {
  let commit = false, entered = false;
  const x = setup({
    resync: async (_client, signal) => {
      entered = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      return () => {
        commit = true;
      };
    },
  });
  const start = x.stream.start();
  const rejected = assertRejects(() => start);
  await until(() => entered);
  await x.stream.stop();
  await rejected;
  assertEquals(commit, false);
});
Deno.test("V2 stream awaits reconnect backfill before buffered events and readiness", async () => {
  const gate = Promise.withResolvers<void>();
  let entered = false;
  const x = setup({
    resync: () =>
      Promise.resolve(async () => {
        entered = true;
        await gate.promise;
      }),
  });
  const starting = x.stream.start();
  try {
    await until(() => entered);
    x.send({
      id: "backfill-race",
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" },
    });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(x.applied.length, 0);
    assertEquals(x.order.includes("ready"), false);
    gate.resolve();
    await starting;
    await until(() => x.applied.length === 1);
    assertEquals(x.order.at(-1), "ready");
  } finally {
    gate.resolve();
    await x.stream.stop();
  }
});
Deno.test("V2 execution salvage keeps valid run facts from drifted frames", () => {
  assertEquals(
    decodeEvent({
      id: 99,
      type: "session.execution.failed",
      data: { sessionID: "ses_1" },
      location: "drift",
    }),
    { type: "session.execution.failed", data: { sessionID: "ses_1" } },
  );
  assertEquals(
    decodeEvent({
      id: 99,
      type: "session.text.delta",
      data: { sessionID: "ses_1" },
    }),
    undefined,
  );
  assertEquals(V2_SILENCE_MS, 45_000);
});

Deno.test("V2 subscribed consumer delivers salvaged execution frames without reconnecting", async () => {
  const x = setup();
  try {
    await x.stream.start();
    x.send({
      id: 99,
      type: "session.execution.failed",
      data: { sessionID: "ses_1" },
      location: "schema drift",
    });
    await until(() => x.applied.length === 1);
    assertEquals(x.applied, [{
      type: "session.execution.failed",
      data: { sessionID: "ses_1" },
    }]);
    assertEquals(x.controllers.length, 1);
  } finally {
    await x.stream.stop();
  }
});

Deno.test("V2 byte watchdog uses 45 seconds, observes comments and reconnects on silence", async () => {
  const original = globalThis.setTimeout;
  const thresholds: number[] = [];
  // Test-owned clock compression, not a product timeout/test hook.
  globalThis.setTimeout =
    ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === V2_SILENCE_MS) thresholds.push(ms);
      return original(
        handler,
        ms === V2_SILENCE_MS ? 80 : ms === 1000 ? 1 : ms,
        ...args,
      );
    }) as typeof setTimeout;
  const x = setup();
  try {
    await x.stream.start();
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => original(resolve, 30));
      x.controllers[0].enqueue(new TextEncoder().encode(": heartbeat\n\n"));
    }
    assertEquals(x.controllers.length, 1);
    await until(() => x.controllers.length === 2);
    assertEquals(thresholds.length >= 4, true);
    assertEquals(
      x.diagnostics.some((error) => String(error).includes("silent")),
      true,
    );
  } finally {
    await x.stream.stop();
    globalThis.setTimeout = original;
  }
});
