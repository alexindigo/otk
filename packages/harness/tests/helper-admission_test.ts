// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import { bounded, test } from "../../../tests/support/resources.ts";
for (const interruptible of [true, undefined]) {
  test(`held background ${interruptible ? "helper" : "header"} reads yield their scheduler slot to essential parent metadata`, async () => {
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<string | undefined>();
    let attempts = 0;
    const scheduler = new DigestScheduler({
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 128,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    }, { freeMemory: () => 100, sleep: () => Promise.resolve() });
    scheduler.register({
      identity: "test",
      catalog: () => Promise.resolve({ entries: [], authoritative: true }),
      detail: () => Promise.reject(),
      close() {},
      step(_job, _budget, signal, execution) {
        attempts++;
        entered.resolve();
        const abort = () => ready.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        return execution.wait(
          ready.promise.finally(() =>
            signal.removeEventListener("abort", abort)
          ),
          "io",
        );
      },
    });
    scheduler.enqueue({
      provider: "test",
      sessionID: "tstv1-helper",
      updated: 1,
      projection: "helper",
      interruptible,
    }, "background");
    const work = scheduler.tick();
    try {
      await entered.promise;
      const read = scheduler.execute(
        () => Promise.resolve("parent metadata"),
        new AbortController().signal,
      );
      let delivered = false;
      const outcome = read.then((value) => ({ value }), (error) => ({ error }))
        .finally(() => {
          delivered = true;
        });
      await bounded("helper yields", work, 1000);
      await bounded(
        "parent metadata admitted",
        (async () => {
          while (!delivered) {
            await scheduler.tick();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        })(),
        1000,
      );
      assertEquals(await outcome, { value: "parent metadata" });
      assertEquals(
        scheduler.queued,
        1,
        "Waiting helper must retain its reconciliation intent",
      );
      assertEquals(
        attempts,
        1,
        "A CPU-only read needs no native I/O preemption",
      );
      ready.resolve(undefined);
      await bounded(
        "helper resumes without losing progress",
        (async () => {
          while (scheduler.queued) {
            await scheduler.tick();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        })(),
        1000,
      );
      assertEquals(attempts, 1);
      assertEquals(scheduler.queued, 0);
    } finally {
      await scheduler.stop();
      await work.catch(() => {});
    }
  });
}
