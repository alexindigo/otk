// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { markdown, StreamingMarkdown } from "@otk/content";

Deno.test("CommonMark EOF fences interrupt paragraphs, including nested and stray fences", () => {
  for (const source of ["prose\n```", "prose\n~~~", "prose\n```sh"]) {
    const expected = markdown(source + "\n");
    assertEquals(expected.map((b) => b.b), ["paragraph", "code"]);
    assertEquals(markdown(source), expected);
    const stream = new StreamingMarkdown();
    for (const char of source) {
      stream.append(char);
      stream.flush();
    }
    assertEquals(stream.finish().blocks, expected);
  }
  assertEquals(markdown("````\n```\n````"), [{
    b: "code",
    lang: undefined,
    text: "```",
  }]);
  assertEquals(markdown("```\nexact <text>\n```"), [{
    b: "code",
    lang: undefined,
    text: "exact <text>",
  }]);
});
