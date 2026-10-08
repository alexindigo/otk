// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { codeLines } from "../../../web/src/highlight/lines.ts";
Deno.test("highlight lines preserve exact text, empty lines and stable prefix identity across recall", () => {
  const first = codeLines([{
    content: "const a = 1;\n\n",
    color: "var(--keyword)",
  }, { content: "ta", color: "var(--fg)" }]);
  const next = codeLines([{
    content: "const a = 1;\n\n",
    color: "var(--keyword)",
  }, { content: "tail", color: "var(--fg)" }], first);
  assertStrictEquals(next[0], first[0]);
  assertStrictEquals(next[1], first[1]);
  assertNotStrictEquals(next[2], first[2]);
  assertEquals(
    next.map((line) =>
      line.tokens.map((token) => token.content).join("") +
      (line.newline ? "\n" : "")
    ).join(""),
    "const a = 1;\n\ntail",
  );
  assertEquals(next.map((line) => line.end), [13, 14, 18]);
  assertEquals(codeLines([{ content: "\n\n" }]).length, 2);
});
