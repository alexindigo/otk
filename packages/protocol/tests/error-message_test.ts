// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { errorMessage, normalizeError } from "@otk/protocol";

Deno.test("unknown failure conversion preserves useful text without throwing on arbitrary values", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const hostile = {
    get message(): string {
      throw null;
    },
  };
  for (
    const [value, expected] of [
      [new Error("native failure"), "native failure"],
      ["injected failure", "injected failure"],
      [{ message: "plain failure", code: "native" }, "plain failure"],
      [{ reason: "failed" }, '{"reason":"failed"}'],
      [null, "Unknown error"],
      [undefined, "Unknown error"],
      ["", "Unknown error"],
      [0, "0"],
      [false, "false"],
      [7n, "Unknown error"],
      [circular, "Unknown error"],
      [hostile, "Unknown error"],
    ] as const
  ) assertEquals(errorMessage(value), expected);
  const original = Object.assign(new Error("owned failure"), { code: "owned" });
  assertStrictEquals(normalizeError(original), original);
  const converted = normalizeError("not an Error");
  assertEquals(converted.message, "not an Error");
  assertEquals(converted.cause, "not an Error");
});
