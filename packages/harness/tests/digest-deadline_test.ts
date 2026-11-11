// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DigestScheduler } from "../digest-scheduler.ts";
import { cfg } from "../../../tests/support/config.ts";

for (const gate of ["idle", "duty"] as const) {
  Deno.test(`digest ${gate} deadline crossing cannot park runnable work without a wake`, async () => {
    let now = 0, wakes = 0;
    const readings: number[] = [];
    const sleeps: { ms: number; signal: AbortSignal; finish(): void }[] = [];
    const scheduler = new DigestScheduler({
      ...cfg().digest,
      idlems: 20,
      cpu: 0.5,
    }, {
      freeMemory: () => Number.MAX_SAFE_INTEGER,
      now: () => readings.shift() ?? now,
      wake: () => wakes++,
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          sleeps.push({
            ms,
            signal,
            finish: () => {
              signal.removeEventListener("abort", abort);
              resolve();
            },
          });
        }),
    });
    let started = false;
    scheduler.register({
      identity: "deadline",
      catalog: () => Promise.resolve({ entries: [], authoritative: true }),
      detail: () => Promise.reject(new Error("unused")),
      close() {},
      step: () => {
        started = true;
        return Promise.resolve(undefined);
      },
    });
    try {
      if (gate === "idle") {
        scheduler.requested();
        // A native timer can fire just before its monotonic deadline.
        now = 19;
        sleeps[0].finish();
      } else {
        scheduler.charge(20);
        // Interactive work cancels the old duty timer, but not its deadline.
        const essential = scheduler.execute(
          () => Promise.resolve(),
          new AbortController().signal,
        );
        await scheduler.tick();
        await essential;
      }
      for (let n = 0; n < 8; n++) await Promise.resolve();
      assertEquals(sleeps.length, 1);
      scheduler.enqueue({
        provider: "deadline",
        sessionID: "one",
        updated: 1,
      }, "background");
      now = 21;
      readings.push(
        ...(gate === "idle" ? [19.999, 20.001] : [21, 19.999, 20.001]),
      );
      const before = wakes;
      const executed = await scheduler.tick();
      // Admission and its timer must share the same deadline observation.
      assert(
        executed || wakes > before || sleeps.length > 1,
        "deadline crossed after eligibility check: no execution, timer or future wake",
      );
      for (const sleep of sleeps.slice(1)) sleep.finish();
      for (let n = 0; n < 8; n++) await Promise.resolve();
      while (await scheduler.tick()) { /* Drain the now-idle job. */ }
      assertEquals(started, true);
    } finally {
      await scheduler.stop();
    }
  });
}
