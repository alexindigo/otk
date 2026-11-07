// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import { bounded, test } from "../../../tests/support/resources.ts";

test("interactive reads preempt the actual duty wait while background retains its remaining quota", async () => {
  let clock = 0;
  const seen: string[] = [],
    firstSleep = Promise.withResolvers<void>(),
    secondSleep = Promise.withResolvers<void>();
  const sleeps: { ms: number; signal: AbortSignal; release(): void }[] = [];
  const scheduler = new DigestScheduler({
    batch: 100,
    slicems: 8,
    cpu: .25,
    memoryreserve: 1,
    maxpending: 512,
    idlems: 1,
    parallel: 3,
    background: false,
    publishrows: 64,
    retryms: 1000,
    busyms: 100,
  }, {
    freeMemory: () => 1000,
    now: () => clock,
    sleep(ms, signal) {
      const gate = Promise.withResolvers<void>();
      const abort = () => gate.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      sleeps.push({ ms, signal, release: () => gate.resolve() });
      if (sleeps.length === 1) firstSleep.resolve();
      if (sleeps.length === 2) secondSleep.resolve();
      if (sleeps.length > 2) gate.resolve();
      return gate.promise.finally(() =>
        signal.removeEventListener("abort", abort)
      );
    },
  });
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    close() {},
    step(job) {
      seen.push(job.sessionID);
      clock += 10;
      return Promise.resolve(undefined);
    },
  });
  scheduler.enqueue({
    provider: "test-v1",
    sessionID: "tstv1-first",
    updated: 1,
  }, "background");
  const background = scheduler.tick();
  let next: Promise<boolean> | undefined;
  try {
    await firstSleep.promise;
    assertEquals(sleeps[0].ms, 30);
    const read = scheduler.execute(() => {
      seen.push("interactive");
      return Promise.resolve("essential outcome");
    }, new AbortController().signal);
    const outcome = read.then((value) => ({ value }), (error) => ({ error }));
    const delivered = await bounded(
      "interactive read preempts duty wait",
      (async () => {
        await background;
        await scheduler.tick();
        return await outcome;
      })(),
      1000,
    );
    assertEquals(delivered, { value: "essential outcome" });
    assertEquals(sleeps[0].signal.aborted, true);
    scheduler.enqueue({
      provider: "test-v1",
      sessionID: "tstv1-next",
      updated: 2,
    }, "background");
    next = scheduler.tick();
    await bounded(
      "remaining background quota admitted",
      secondSleep.promise,
      1000,
    );
    assertEquals(seen, ["tstv1-first", "interactive"]);
    assertEquals(sleeps[1].ms, 30);
    clock = 40;
    sleeps[1].release();
    await next;
    await scheduler.tick();
    assertEquals(seen, ["tstv1-first", "interactive", "tstv1-next"]);
  } finally {
    await scheduler.stop();
    await Promise.allSettled([background, ...(next ? [next] : [])]);
  }
});
