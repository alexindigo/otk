// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { countLabel } from "../components/tools/count.ts";
Deno.test("row count labels share zero, singular and plural forms", () => {
  for (
    const [singular, plural] of [
      ["match", "matches"],
      ["entry", "entries"],
      ["tool call", "tool calls"],
      ["line", "lines"],
      ["question", "questions"],
    ]
  ) {
    for (const count of [0, 1, 2]) {
      assertEquals(
        countLabel(count, singular, plural),
        `${count} ${count === 1 ? singular : plural}`,
      );
    }
  }
  assertEquals(countLabel(1, "file"), "1 file");
  assertEquals(countLabel(2, "file"), "2 files");
});

Deno.test("formatted count labels inflect the numeric value, not compact or locale display text", () => {
  assertEquals(countLabel(0, "token"), "0 tokens");
  assertEquals(countLabel(1, "token"), "1 token");
  assertEquals(countLabel(1000, "token", undefined, "1K"), "1K tokens");
  assertEquals(countLabel(1234, "token", undefined, "1,234"), "1,234 tokens");
  assertEquals(countLabel(1, "token", undefined, "1 of 1"), "1 of 1 token");
  assertEquals(countLabel(2, "token", undefined, "1 of 2"), "1 of 2 tokens");
  assertEquals(
    countLabel(1, "session needs attention", "sessions need attention"),
    "1 session needs attention",
  );
  assertEquals(
    countLabel(2, "session needs attention", "sessions need attention"),
    "2 sessions need attention",
  );
});
