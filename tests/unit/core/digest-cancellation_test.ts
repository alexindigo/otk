// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import { DigestRequests } from "../../../core/digest/requests.ts";
import { bounded, test } from "../../support/resources.ts";

const policy = {
  batch: 2,
  slicems: 8,
  cpu: 1,
  memoryreserve: 1,
  maxpending: 2,
  publishrows: 2,
  retryms: 10,
  busyms: 100,
};
test("release aborts the native read and releases the scheduler slot", async () => {
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const requests = new DigestRequests("run-a", scheduler);
  const started = Promise.withResolvers<void>();
  let aborted = false;
  const read = requests.run(
    "run-a",
    1,
    (signal) =>
      new Promise<void>((_resolve, reject) => {
        started.resolve();
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
  );
  const rejection = assertRejects(() => read, DOMException, "cancelled");
  const active = scheduler.tick();
  try {
    await started.promise;
    requests.cancel("old-run", 1);
    assertEquals(aborted, false);
    requests.cancel("run-a", 1);
    await bounded("cancel releases native read", rejection, 1000);
    await active;
    assertEquals(aborted, true);
    const next = requests.run("run-a", 2, () => Promise.resolve("next read"));
    await scheduler.tick();
    assertEquals(await next, "next read");
  } finally {
    await requests.stop();
    await active;
    await scheduler.stop();
  }
});

test("late or unknown cancel is ignored and cannot cancel the next request", async () => {
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  const requests = new DigestRequests("run-a", scheduler);
  const first = requests.run("run-a", 1, () => Promise.resolve("first"));
  await scheduler.tick();
  assertEquals(await first, "first");
  requests.cancel("run-a", 1);
  requests.cancel("run-a", 999);
  requests.cancel("run-a", 1);
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const second = requests.run("run-a", 2, async (signal) => {
    started.resolve();
    await release.promise;
    signal.throwIfAborted();
    return "second";
  });
  const active = scheduler.tick();
  await started.promise;
  requests.cancel("run-a", 1);
  requests.cancel("run-a", 999);
  release.resolve();
  await active;
  assertEquals(await second, "second");
  await requests.stop();
  await scheduler.stop();
});
