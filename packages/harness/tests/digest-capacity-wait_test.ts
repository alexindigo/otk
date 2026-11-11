// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DigestScheduler } from "../digest-scheduler.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("a read waiting for batch capacity cannot starve the batch holder", async () => {
  // Each clock reading advances, so every executing turn bills a small duty
  // debt and arms a sub-millisecond duty timer, as on a real worker.
  let now = 0;
  const timers: (() => void)[] = [];
  const scheduler = new DigestScheduler({
    ...cfg().digest,
    parallel: 1,
    cpu: 0.25,
  }, {
    freeMemory: () => Number.MAX_SAFE_INTEGER,
    now: () => now += 0.01,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        timers.push(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      }),
  });
  const io = Promise.withResolvers<void>();
  let holderDone = false, waiterDone = false;
  const controller = new AbortController();
  const holder = scheduler.execute(
    async (_signal, execution) => {
      await execution.wait(io.promise, "io");
    },
    controller.signal,
    "attention",
    true,
    false,
    true,
  ).then(() => holderDone = true);
  const waiter = scheduler.execute(
    () => Promise.resolve(),
    controller.signal,
    "attention",
    true,
    false,
    true,
  ).then(() => waiterDone = true);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Pump: one turn, then the timers that fall due before its zero-delay yield.
  const cycle = async () => {
    const ran = await scheduler.tick();
    for (const fire of timers.splice(0)) fire();
    await settle();
    return ran;
  };
  try {
    await cycle(); // The holder admits the only batch and parks on I/O.
    await cycle(); // The waiter finds no capacity and parks.
    io.resolve();
    await settle();
    for (let n = 0; n < 50 && !holderDone; n++) await cycle();
    assert(holderDone, "capacity waiter kept the executor; holder starved");
    for (let n = 0; n < 50 && !waiterDone; n++) await cycle();
    assertEquals([holderDone, waiterDone], [true, true]);
  } finally {
    controller.abort();
    await scheduler.stop();
    await Promise.allSettled([holder, waiter]);
  }
});
