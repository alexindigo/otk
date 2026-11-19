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
