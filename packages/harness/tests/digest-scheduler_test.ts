// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type DigestPolicy,
  digestRowFloor,
  DigestScheduler,
} from "@otk/harness";
import { test } from "../../../tests/support/resources.ts";

const policy: DigestPolicy = {
  batch: 100,
  slicems: 8,
  cpu: 0.25,
  memoryreserve: 100,
  maxpending: 2,
  publishrows: 64,
  retryms: 10,
  busyms: 100,
};
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
      execution.charge(1000);
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
