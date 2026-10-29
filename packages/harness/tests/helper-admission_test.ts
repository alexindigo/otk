// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import { bounded, test } from "../../../tests/support/resources.ts";
for (const interruptible of [true, undefined]) {
  test(`held background ${interruptible ? "helper" : "header"} reads yield their scheduler slot to essential parent metadata`, async () => {
    const entered = Promise.withResolvers<void>();
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
      step(_job, _budget, signal) {
        attempts++;
        entered.resolve();
        if (attempts > 1) return Promise.resolve(undefined);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
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
      const outcome = read.then((value) => ({ value }), (error) => ({ error }));
      await bounded("helper yields", work, 1000);
      await scheduler.tick();
      assertEquals(await outcome, { value: "parent metadata" });
      assertEquals(
        scheduler.queued,
        1,
        "Cancelled helper must retain its reconciliation intent",
      );
      await scheduler.tick();
      assertEquals(attempts, 2);
      assertEquals(scheduler.queued, 0);
    } finally {
      await scheduler.stop();
      await work.catch(() => {});
    }
  });
}
