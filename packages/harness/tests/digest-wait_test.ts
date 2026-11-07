// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import { bounded, test } from "../../../tests/support/resources.ts";

const policy = {
  idlems: 1,
  parallel: 3,
  background: false,
  batch: 2,
  slicems: 8,
  cpu: 1,
  memoryreserve: 1,
  maxpending: 128,
  publishrows: 2,
  retryms: 10,
  busyms: 100,
};
test("essential admission is independent of background memory sampling at full catalog scale", async () => {
  let samples = 0;
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => {
      samples++;
      return 1000;
    },
    sleep: () => Promise.resolve(),
  });
  scheduler.register({
    identity: "fixture",
    catalog: () => Promise.reject(),
    detail: () => Promise.reject(),
    step: () => Promise.resolve(undefined),
    close() {},
  });
  for (let i = 0; i < 4615; i++) {
    scheduler.enqueue(
      { provider: "fixture", sessionID: `s${i}`, updated: i },
      "background",
    );
  }
  const essential = scheduler.execute(
    () => Promise.resolve("metadata"),
    new AbortController().signal,
  );
  const outcome = Promise.allSettled([essential]);
  try {
    await scheduler.tick();
    assertEquals(await essential, "metadata");
    assertEquals(
      samples,
      0,
      "An essential turn must not query background resource permission",
    );
    await scheduler.tick();
    assertEquals(
      samples <= 2,
      true,
      "One background turn samples admission, not every queued identity",
    );
  } finally {
    await scheduler.stop();
    await outcome;
  }
});
test("credit, I/O and lock readiness yield execution and requeue continuations at their own priorities", async () => {
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const gates = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const seen: string[] = [];
  const controller = new AbortController();
  const work = gates.map((gate, i) =>
    scheduler.execute(
      async (_signal, execution) => {
        seen.push(`start-${i}`);
        await execution.wait(gate.promise);
        seen.push(`resume-${i}`);
      },
      controller.signal,
      ["background", "visible", "attention"][i] as
        | "background"
        | "visible"
        | "attention",
    )
  );
  // Attach rejection observers before driving the first (possibly red) turn.
  const outcomes = Promise.allSettled(work);
  try {
    for (let i = 0; i < 3; i++) {
      await bounded("wait releases slot", scheduler.tick(), 200);
    }
    assertEquals(seen, ["start-2", "start-1", "start-0"]);
    gates.forEach((gate) => gate.resolve());
    await Promise.resolve();
    await Promise.resolve();
    const read = scheduler.execute(() => {
      seen.push("essential");
      return Promise.resolve("metadata");
    }, controller.signal);
    for (let i = 0; i < 4; i++) await scheduler.tick();
    assertEquals(await read, "metadata");
    assertEquals(seen, [
      "start-2",
      "start-1",
      "start-0",
      "essential",
      "resume-2",
      "resume-1",
      "resume-0",
    ]);
    assertEquals(
      (await outcomes).every((result) => result.status === "fulfilled"),
      true,
    );
  } finally {
    controller.abort();
    gates.forEach((gate) => gate.resolve());
    await scheduler.stop();
    await outcomes;
  }
});

test("cancellation retires a waiting continuation and late readiness cannot re-enter it", async () => {
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const controller = new AbortController(),
    credit = Promise.withResolvers<void>();
  let resumed = false;
  const work = scheduler.execute(
    async (_signal, execution) => {
      await execution.wait(credit.promise);
      resumed = true;
    },
    controller.signal,
    "background",
  );
  const rejected = assertRejects(() => work, DOMException, "retired");
  try {
    await bounded("waiting turn", scheduler.tick(), 200);
    controller.abort(new DOMException("retired", "AbortError"));
    let settled = false;
    void work.catch(() => {
      settled = true;
    });
    await bounded(
      "cancelled continuation joins",
      (async () => {
        while (!settled) {
          await scheduler.tick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })(),
      500,
    );
    await rejected;
    credit.resolve();
    await Promise.resolve();
    await scheduler.tick();
    assertEquals(resumed, false);
  } finally {
    credit.resolve();
    await scheduler.stop();
  }
});

test("scheduler shutdown joins suspended cleanup before closing its SQLite-owning sink", async () => {
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const readiness = Promise.withResolvers<void>(), seen: string[] = [];
  scheduler.register({
    identity: "fixture",
    catalog: () => Promise.reject(),
    detail: () => Promise.reject(),
    step: () => Promise.resolve(undefined),
    close() {
      seen.push("close");
    },
  });
  const work = scheduler.execute(async (_signal, execution) => {
    try {
      await execution.wait(readiness.promise);
    } finally {
      seen.push("cleanup");
    }
  }, new AbortController().signal);
  const outcome = Promise.allSettled([work]);
  await scheduler.tick();
  await bounded("join waiting cleanup", scheduler.stop(), 500);
  assertEquals(seen, ["cleanup", "close"]);
  assertEquals((await outcome)[0].status, "rejected");
  readiness.resolve();
});

test("a failed background identity backs off without stopping essential admission", async () => {
  const entered = Promise.withResolvers<void>(),
    delay = Promise.withResolvers<void>();
  const error = new Error("fixture background failure");
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: (_ms, signal) => {
      const abort = () => delay.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      entered.resolve();
      return delay.promise.finally(() =>
        signal.removeEventListener("abort", abort)
      );
    },
  });
  scheduler.register({
    identity: "fixture",
    catalog: () => Promise.reject(),
    detail: () => Promise.reject(),
    step: () => Promise.reject(error),
    close() {},
  });
  scheduler.enqueue(
    { provider: "fixture", sessionID: "broken", updated: 1 },
    "background",
  );
  try {
    await scheduler.tick();
    await bounded("failure owns its own backoff", entered.promise, 200);
    let delivered = false, reported = 0;
    const read = scheduler.execute(
      () => Promise.resolve("essential"),
      new AbortController().signal,
    ).finally(() => {
      delivered = true;
    });
    await bounded(
      "essential read during failure backoff",
      (async () => {
        while (!delivered) {
          try {
            await scheduler.tick();
          } catch (cause) {
            assertEquals(cause, error);
            reported++;
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })(),
      500,
    );
    assertEquals(await read, "essential");
    assertEquals(reported, 1);
  } finally {
    await scheduler.stop();
  }
});
