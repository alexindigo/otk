// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch } from "@std/assert";
import { submissionID } from "../submission-id.ts";

Deno.test("V1 submission identities keep native shape and order within the same clock", () => {
  const now = Date.now;
  Date.now = () => 1794751200000;
  try {
    const first = submissionID(), second = submissionID();
    assertMatch(first, /^msg_[0-9a-f]{26}$/);
    assertEquals(
      first.slice(4, 16),
      (BigInt(Date.now()) * 0x1000n).toString(16).slice(-12),
    );
    assert(second > first);
  } finally {
    Date.now = now;
  }
});
