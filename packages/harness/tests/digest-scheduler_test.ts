// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type DigestPolicy,
  digestRowFloor,
  DigestScheduler,
} from "@otk/harness";
import { test } from "../../../tests/support/resources.ts";

const policy: DigestPolicy = {
  idlems: 20,
  parallel: 3,
  background: false,
  batch: 100,
  slicems: 8,
  cpu: 0.25,
  memoryreserve: 100,
  maxpending: 2,
  publishrows: 64,
  retryms: 10,
  busyms: 100,
};
test("requested visible reads precede optional attention batches after idle opens", async () => {
  const seen: string[] = [];
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    now: () => 100,
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("unused")),
    close() {},
    step(job) {
      seen.push(`backfill:${job.sessionID}`);
      return Promise.resolve(undefined);
    },
  });
  for (let n = 0; n < 2; n++) {
    scheduler.enqueue(
      { provider: "test-v1", sessionID: String(n), updated: n },
      "attention",
    );
  }
  const requested = scheduler.execute(
    () => {
      seen.push("requested");
      return Promise.resolve();
    },
    new AbortController().signal,
    "visible",
  );
  try {
    while (await scheduler.tick()) { /* drain this finite workload */ }
    await requested;
    assertEquals(seen[0], "requested");
    assertEquals(
      seen.filter((value) => value.startsWith("backfill:")).length,
      2,
    );
  } finally {
    await scheduler.stop();
    await Promise.allSettled([requested]);
  }
});
test("requested visible continuations resume before optional attention continuations", async () => {
  const seen: string[] = [],
    ready = Promise.withResolvers<void>(),
    idle = Promise.withResolvers<void>();
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    now: () => 100,
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const requested = scheduler.execute(
    async (_signal, execution) => {
      seen.push("requested:start");
      await execution.wait(ready.promise, "io");
      seen.push("requested:resume");
    },
    new AbortController().signal,
    "visible",
  );
  await scheduler.tick();
  const optional = scheduler.execute(
    async (_signal, execution) => {
      seen.push("backfill:start");
      await execution.wait(idle.promise, "io");
      seen.push("backfill:resume");
    },
    new AbortController().signal,
    "attention",
    false,
    false,
    true,
  );
  await scheduler.tick();
  try {
    ready.resolve();
    idle.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (await scheduler.tick()) { /* readiness has entered both queues */ }
    await Promise.all([requested, optional]);
    assertEquals(seen, [
      "requested:start",
      "backfill:start",
      "requested:resume",
      "backfill:resume",
    ]);
  } finally {
    ready.resolve();
    idle.resolve();
    await scheduler.stop();
    await Promise.allSettled([requested, optional]);
  }
});
test("optional transient reads share the idle and parallel entry-batch budget", async () => {
  let now = 0, starts = 0;
  const release = Promise.withResolvers<void>();
  const scheduler = new DigestScheduler({ ...policy, cpu: 1, parallel: 2 }, {
    now: () => now,
    freeMemory: () => 1000,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      ),
  });
  scheduler.requested();
  const reads = Array.from(
    { length: 4 },
    () =>
      scheduler.execute(
        async (_signal, execution) => {
          starts++;
          await execution.wait(release.promise, "io");
        },
        new AbortController().signal,
        "background",
        true,
        false,
        true,
      ),
  );
  try {
    while (await scheduler.tick()) { /* idle gate parks speculation */ }
    assertEquals(starts, 0);
    now = 20;
    while (await scheduler.tick()) { /* only two admitted I/O lifetimes */ }
    assertEquals(starts, 2);
    scheduler.requested();
    release.resolve();
    await Promise.resolve();
    while (await scheduler.tick()) { /* admitted settlement drains */ }
    assertEquals(starts, 2);
    now = 40;
    while (await scheduler.tick()) { /* successor batches now eligible */ }
    await Promise.all(reads);
    assertEquals(starts, 4);
  } finally {
    release.resolve();
    await scheduler.stop();
    await Promise.allSettled(reads);
  }
});
test("high membership upgrades normal work, yields one batch at a break and retires before source discovery", async () => {
  let now = 0;
  const seen: string[] = [];
  const scheduler = new DigestScheduler({ ...policy, cpu: 1, parallel: 1 }, {
    now: () => now,
    freeMemory: () => 1000,
    sleep: (_ms, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      ),
    discover: () => {
      seen.push("source");
      return Promise.resolve(false);
    },
  });
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("unused")),
    close() {},
    step(job) {
      seen.push(`${job.sessionID}:${job.cursor ?? "newest"}`);
      if (job.sessionID === "high" && !job.cursor) {
        scheduler.requested();
        return Promise.resolve("older");
      }
      return Promise.resolve(undefined);
    },
  });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "normal", updated: 100 },
    "attention",
  );
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "high", updated: 1 },
    "background",
  );
  scheduler.promote({
    provider: "test-v1",
    sessionID: "high",
    updated: 1,
    backfill: "high",
  }, "background");
  while (await scheduler.tick()) { /* one batch, then a client break */ }
  assertEquals(seen, ["high:newest"]);
  assertEquals(scheduler.queued, 2);
  now = 20;
  while (
    await scheduler.tick()
  ) { /* drain memberships, then bounded discovery */ }
  assertEquals(seen, ["high:newest", "high:older", "normal:newest", "source"]);
  assertEquals(scheduler.queued, 0);
  await scheduler.stop();
});
test("requests gate promoted idle batches, bound waiting admission and preempt at the next chunk", async () => {
  let now = 0;
  const sleeps: { at: number; signal: AbortSignal; resolve(): void }[] = [];
  const scheduler = new DigestScheduler({ ...policy, cpu: 1, parallel: 2 }, {
    freeMemory: () => 1000,
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push({ at: now + ms, signal, resolve });
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("unused")),
    close() {},
    async step(job, _budget, _signal, execution) {
      seen.push(`${job.sessionID}:${job.cursor ?? "first"}`);
      if (!job.cursor) await execution.wait(release.promise, "io");
      return job.cursor ? undefined : "next";
    },
  });
  for (let i = 0; i < 4; i++) {
    scheduler.enqueue(
      { provider: "test-v1", sessionID: String(i), updated: i },
      "attention",
    );
  }
  for (now = 0; now < 100; now += 10) {
    scheduler.requested();
    assertEquals(await scheduler.tick(), false);
  }
  now = 109;
  assertEquals(await scheduler.tick(), false);
  now = 110;
  for (const sleep of sleeps) {
    if (sleep.at <= now && !sleep.signal.aborted) sleep.resolve();
  }
  while (await scheduler.tick()) { /* admit bounded waiting batches */ }
  assertEquals(seen, ["3:first", "2:first"]);
  scheduler.requested();
  const requested = scheduler.execute(
    () => {
      seen.push("requested");
      return Promise.resolve();
    },
    new AbortController().signal,
    "visible",
  );
  await scheduler.tick();
  await requested;
  release.resolve();
  await Promise.resolve();
  while (await scheduler.tick()) { /* admitted cleanup drains only */ }
  assertEquals(seen, ["3:first", "2:first", "requested"]);
  now += 20;
  while (await scheduler.tick()) { /* resume cursors */ }
  assertEquals(scheduler.queued, 0);
  await scheduler.stop();
});
test("an admitted idle discovery read drains settlement after ingress while its successor remains parked", async () => {
  let now = 0, starts = 0, settled = false;
  let changed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scheduler = new DigestScheduler({ ...policy, cpu: 1, parallel: 1 }, {
    now: () => now,
    freeMemory: () => 1000,
    wake: () => changed.resolve(),
    sleep: (_ms, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      ),
    discover: async (_signal, execution) => {
      starts++;
      await execution.wait(release.promise, "io");
      settled = true;
      return true;
    },
  });
  while (await scheduler.tick()) { /* admit one source slice */ }
  assertEquals(starts, 1);
  scheduler.requested();
  changed = Promise.withResolvers<void>();
  release.resolve();
  await changed.promise;
  while (await scheduler.tick()) { /* admitted cleanup drains */ }
  assertEquals(settled, true);
  assertEquals(starts, 1);
  now = 20;
  await scheduler.stop();
});
test("upgrading active normal metadata to high does not invalidate its completing batch", async () => {
  let starts = 0, changed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
    wake: () => changed.resolve(),
  });
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("unused")),
    close() {},
    async step(_job, _budget, _signal, execution) {
      starts++;
      await execution.wait(release.promise);
      return undefined;
    },
  });
  const identity = { provider: "test-v1", sessionID: "one", updated: 1 };
  scheduler.enqueue(identity, "background");
  while (await scheduler.tick()) { /* bounded read is waiting */ }
  assertEquals(
    scheduler.promote({ ...identity, backfill: "high" }, "attention"),
    true,
  );
  changed = Promise.withResolvers<void>();
  release.resolve();
  await changed.promise;
  while (await scheduler.tick()) { /* finish the promoted read */ }
  assertEquals(starts, 1);
  assertEquals(scheduler.queued, 0);
  await scheduler.stop();
});

for (const background of [false, true]) {
  test(`no-viewer idle batches follow background=${background}; essential reads remain live`, async () => {
    const scheduler = new DigestScheduler({ ...policy, background, cpu: 1 }, {
      freeMemory: () => 1000,
      sleep: () => Promise.resolve(),
    });
    scheduler.viewers(false);
    let starts = 0;
    scheduler.register({
      identity: "test-v1",
      catalog: () => Promise.resolve({ entries: [], authoritative: true }),
      detail: () => Promise.reject(new Error("unused")),
      close() {},
      step() {
        starts++;
        return Promise.resolve(undefined);
      },
    });
    scheduler.enqueue(
      { provider: "test-v1", sessionID: "one", updated: 1 },
      "attention",
    );
    while (await scheduler.tick()) { /* idle fill */ }
    assertEquals(starts, background ? 1 : 0);
    const essential = scheduler.execute(
      () => Promise.resolve("lamp"),
      new AbortController().signal,
      "attention",
    );
    await scheduler.tick();
    assertEquals(await essential, "lamp");
    await scheduler.stop();
  });
}
test("time-budget adaptation retains the configured native-read amortization floor", async () => {
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
  const rows: number[] = [];
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    close() {},
    step(_job, budget, _signal, execution) {
      rows.push(budget.rows);
      // Expensive per-row work: the quota shrinks, but never below the floor.
      execution.rows?.(budget.rows);
      execution.charge(10 * budget.rows);
      return Promise.resolve(rows.length < 3 ? "next" : undefined);
    },
  });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "floor", updated: 1 },
    "background",
  );
  while (await scheduler.tick()) { /* bounded slices */ }
  assertEquals(digestRowFloor(policy), 13);
  assertEquals(rows, [100, 13, 13]);
  await scheduler.stop();
});
test("a slow fixed-cost chunk cannot pin later work to the row floor; cheap work recovers the quota", async () => {
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
  const quotas: number[] = [];
  let phase: "fixed" | "rows" | "cheap" = "fixed", steps = 0;
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    close() {},
    step(_job, budget, _signal, execution) {
      quotas.push(budget.rows);
      // Sessions differ in size; the examined rows vary naturally.
      const examined = [budget.rows, 0, 2, Math.ceil(budget.rows / 2)][
        steps++ % 4
      ];
      execution.rows?.(examined);
      execution.charge(
        phase === "fixed"
          ? 250 // proof/commit/publication, independent of rows
          : phase === "rows"
          ? 1 + 2 * examined
          : 1 + 0.01 * examined,
      );
      return Promise.resolve(steps < 60 ? "next" : undefined);
    },
  });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "fixed", updated: 1 },
    "background",
  );
  while (await scheduler.tick()) {
    if (steps === 20) phase = "rows";
    if (steps === 40) phase = "cheap";
  }
  // Once rows vary, a large fixed cost alone no longer shrinks the quota.
  assertEquals(quotas.slice(2, 20).every((rows) => rows === 100), true);
  // Expensive rows shrink it to the per-row budget (8 ms / 2 ms), not below the floor.
  assertEquals(quotas.slice(25, 40).every((rows) => rows === 13), true);
  // Cheap rows recover it.
  assertEquals(quotas.slice(-3), [100, 100, 100]);
  await scheduler.stop();
});
test("an essential read interposes between fixed-cost background chunks", async () => {
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
  const order: string[] = [];
  let steps = 0;
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    close() {},
    step(_job, budget, _signal, execution) {
      order.push(`chunk:${budget.rows}`);
      execution.rows?.(steps % 2 ? 0 : budget.rows);
      execution.charge(250);
      return Promise.resolve(++steps < 4 ? "next" : undefined);
    },
  });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "bulk", updated: 1 },
    "background",
  );
  assertEquals(await scheduler.tick(), true);
  const essential = scheduler.execute(() => {
    order.push("essential");
    return Promise.resolve();
  }, new AbortController().signal);
  while (await scheduler.tick()) { /* drain */ }
  await essential;
  assertEquals(order[0], "chunk:100");
  assertEquals(order[1], "essential");
  assertEquals(order.slice(2), ["chunk:13", "chunk:100", "chunk:100"]);
  await scheduler.stop();
});
test("requested identities bypass parked idle keys and release their original optional admission after upgrade", async () => {
  let now = 0;
  const scheduler = new DigestScheduler({ ...policy, parallel: 1, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      ),
    now: () => now,
  });
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("unused")),
    close() {},
    async step(job, _budget, _signal, execution) {
      seen.push(job.sessionID);
      if (job.sessionID === "held") await execution.wait(release.promise, "io");
    },
  });
  scheduler.requested();
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "held", updated: 2 },
    "attention",
  );
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "requested", updated: 1 },
    "visible",
    undefined,
    false,
  );
  while (await scheduler.tick()) {
    /* requested work bypasses the parked heap */
  }
  assertEquals(seen, ["requested"]);
  now = policy.idlems;
  await scheduler.tick();
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "held", updated: 2 },
    "attention",
    undefined,
    false,
  );
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "next", updated: 0 },
    "background",
  );
  release.resolve();
  await Promise.resolve();
  for (let turns = 0; turns < 100 && scheduler.queued; turns++) {
    await scheduler.tick();
    await Promise.resolve(); // Completion returns admission before the next wake.
  }
  assertEquals(seen.includes("next"), true);
  assertEquals(scheduler.queued, 0);
  await scheduler.stop();
});
test("attention promotion preserves targeted message keys and does not admit a clean ready session", async () => {
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const jobs: { id: string; messages?: string[] }[] = [];
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    step: (job) => {
      jobs.push({ id: job.sessionID, messages: job.messages });
      return Promise.resolve(undefined);
    },
    close() {},
  });
  const identity = { provider: "test-v1", sessionID: "tstv1-one", updated: 1 };
  scheduler.enqueue(identity, "background", {
    sessionID: identity.sessionID,
    revision: 1,
    reason: "messages",
    messages: ["native-message"],
  });
  scheduler.enqueue(
    { ...identity, sessionID: "tstv1-newer", updated: 2 },
    "background",
  );
  const promote = Reflect.get(scheduler, "promote");
  assertEquals(
    Reflect.apply(promote, scheduler, [identity, "attention"]),
    true,
  );
  assertEquals(
    Reflect.apply(promote, scheduler, [{
      ...identity,
      sessionID: "tstv1-clean",
    }, "attention"]),
    false,
  );
  await scheduler.tick();
  assertEquals(jobs, [{
    id: identity.sessionID,
    messages: ["native-message"],
  }]);
  await scheduler.stop();
});
test("scheduler promotes coalesced identities and retains cursors while pressure yields background", async () => {
  const seen: string[] = [];
  let free = 0;
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => free,
    sleep: () => Promise.resolve(),
  });
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    step: (job, _budget, signal) => {
      signal.throwIfAborted();
      seen.push(`${job.sessionID}:${job.cursor ?? "start"}`);
      return Promise.resolve(job.cursor ? undefined : "next");
    },
    close: () => {},
  });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "tstv1-a", updated: 1 },
    "background",
  );
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "tstv1-b", updated: 2 },
    "background",
  );
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "tstv1-a", updated: 1 },
    "attention",
  );
  assertEquals(await scheduler.tick(), false);
  free = 1000;
  scheduler.interactive("request", true);
  assertEquals(await scheduler.tick(), false);
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "tstv1-b", updated: 2 },
    "interactive",
    undefined,
    false,
  );
  assertEquals(await scheduler.tick(), true);
  scheduler.interactive("request", false);
  while (await scheduler.tick()) { /* drain bounded slices */ }
  assertEquals(seen, [
    "tstv1-b:start",
    "tstv1-b:next",
    "tstv1-a:start",
    "tstv1-a:next",
  ]);
  await scheduler.stop();
});
test("no-viewer pause drains the current slice, parks cursors and admits essential work before resume", async () => {
  const scheduler = new DigestScheduler({ ...policy, cpu: 1 }, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const seen: string[] = [];
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    close() {},
    async step(job, _budget, _signal, execution) {
      seen.push(job.cursor ?? "chunk");
      if (!job.cursor) {
        entered.resolve();
        await execution.wait(release.promise, "io");
        seen.push("settled");
        return "resume";
      }
    },
  });
  scheduler.setScope("viewer", { sessions: [] });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "one", updated: 1 },
    "background",
  );
  await scheduler.tick();
  await entered.promise;
  scheduler.release("viewer");
  release.resolve();
  await Promise.resolve();
  while (await scheduler.tick()) { /* join only the admitted slice */ }
  assertEquals(seen, ["chunk"]);
  assertEquals(scheduler.queued, 1);
  assertEquals(scheduler.waitReason, "paused with no viewers");
  const essential = scheduler.execute(() => {
    seen.push("page");
    return Promise.resolve();
  }, new AbortController().signal);
  scheduler.setScope("next", { sessions: [] });
  await scheduler.tick();
  await essential;
  assertEquals(seen.at(-1), "page");
  while (await scheduler.tick()) { /* resume retained cursor */ }
  assertEquals(seen, ["chunk", "page", "chunk", "settled", "resume"]);
  await scheduler.stop();
});
