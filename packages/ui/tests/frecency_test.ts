// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { frecency } from "@otk/protocol";
import {
  mention,
  mentionQuery,
  rank,
} from "../components/prompt/autocomplete.ts";
Deno.test("frecency ranks canonical paths with TUI daily decay and mention parsing", () => {
  assertEquals(frecency({ path: "x", score: 4, last: 0 }, 86_400_000), 2);
  assertEquals(
    rank(
      [{ id: "a", label: "AAA.md", path: "AAA.md" }, {
        id: "r",
        label: "README.md",
        path: "README.md",
      }],
      "",
      [{ path: "/project/README.md", score: 2, last: Date.now() }],
      "/project",
    )[0].label,
    "README.md",
  );
  assertEquals(mention("hello @READ", 11), {
    start: 6,
    end: 11,
    query: "READ",
  });
  assertEquals(mention("email@example.com", 17), undefined);
  assertEquals(mentionQuery("README.md#10-20"), {
    query: "README.md",
    range: { start: 10, end: 20 },
  });
});
