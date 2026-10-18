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
