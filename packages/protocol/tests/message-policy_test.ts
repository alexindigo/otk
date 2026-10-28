// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { messagePolicy } from "../mod.ts";
Deno.test("welcome message policy has no defaults or unknown fields and preserves operator values", () => {
  const policy = { replayops: 7, replaybytes: 65536, retryms: 321 };
  assertEquals(messagePolicy(policy), policy);
  for (
    const value of [
      undefined,
      {},
      { ...policy, replayops: 0 },
      { ...policy, replaybytes: 127 },
      { ...policy, retryms: Number.MAX_SAFE_INTEGER + 1 },
      { ...policy, retryms: 1.5 },
      { ...policy, extra: 1 },
    ]
  ) assertThrows(() => messagePolicy(value));
});
