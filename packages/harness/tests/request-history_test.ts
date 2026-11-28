// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { SessionErrors } from "../session-errors.ts";
Deno.test("failed history remains visible and retryable without a native resend", async () => {
  const errors = new SessionErrors(() => {});
  let full = true, writes = 0;
  const write = () => {
    writes++;
    if (full) throw new Error("disk full");
  };
  await assertRejects(
    () => errors.retainHistory("s", "request", write),
    Error,
    "disk full",
  );
  assertEquals(errors.snapshot("s").observations.length, 1);
  errors.clear("s");
  assertEquals(errors.snapshot("s").observations[0].cleared, undefined);
  await errors.retryHistory("s");
  assertEquals(writes, 2);
  assertEquals(errors.snapshot("s").observations.length, 1);
  full = false;
  await errors.retryHistory("s");
  assertEquals(writes, 3);
  assertEquals(errors.snapshot("s").observations, []);
});

Deno.test("session deletion drains running history and discards failed or late jobs", async () => {
  const published: number[] = [];
  const errors = new SessionErrors((_id, state) =>
    published.push(state.observations.length)
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const records = new Set<string>();
  let retries = 0;
  await assertRejects(() =>
    errors.retainHistory("s", "failed", () => {
      if (!retries++) throw new Error("disk full");
      records.add("failed");
    })
  );
  const write = errors.retainHistory("s", "running", async () => {
    entered.resolve();
    await release.promise;
    records.add("running");
  });
  await entered.promise;
  const removed = Promise.resolve(errors.remove("s")).then(() =>
    records.clear()
  );
  await errors.retainHistory("s", "late", () => {
    records.add("late");
  });
  release.resolve();
  await Promise.all([write, removed]);
  await errors.retryHistory();
  assertEquals([...records], []);
  assertEquals(retries, 1);
  assertEquals(published, [1, 0]);
});
