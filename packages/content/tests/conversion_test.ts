// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Lexer } from "marked";
import { blocks, markdown, parseDiff, StreamingMarkdown } from "@otk/content";
import type { Block } from "@otk/protocol";

const patch =
  "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n before\n-old\n+new\n";
Deno.test("diff conversion preserves hunk line numbers and add/delete/rename status", () => {
  const [diff] = parseDiff(patch);
  assertEquals(diff.additions, 1);
  assertEquals(diff.deletions, 1);
  assertEquals(diff.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo]), [
    ["context", 1, 1],
    ["del", 2, undefined],
    ["add", undefined, 2],
  ]);
  assertEquals(
    parseDiff(patch.replace("b/example.ts", "b/moved.ts"))[0].status,
    "moved",
  );
  const [added] = parseDiff(
    "--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1,1 @@\n+new\n",
  );
  assertEquals([added.path, added.status, added.additions, added.deletions], [
    "added.ts",
    "added",
    1,
    0,
  ]);
  const [deleted] = parseDiff(
    "--- a/deleted.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n",
  );
  assertEquals([
    deleted.path,
    deleted.status,
    deleted.additions,
    deleted.deletions,
  ], ["deleted.ts", "deleted", 0, 1]);
});
Deno.test("markdown maps every block and inline shape and represents HTML as text", () => {
  const content = markdown(
    "# Heading\n\n**bold** *em* ~~deleted~~ `code` [link](https://example.com) ![alt](https://example.com/a.png)  \nnext\n\n> quote\n\n- [x] done\n- item\n\n|A|B|\n|:-|--:|\n|one|two|\n\n---\n\n```ts\nconst x=1;\n```\n\n<script>alert(1)</script>\n",
  );
  assertEquals(content.map((b) => b.b), [
    "heading",
    "paragraph",
    "quote",
    "list",
    "table",
    "rule",
    "code",
    "paragraph",
  ]);
  assert(JSON.stringify(content).includes("<script>"));
  assert(content[1].b === "paragraph");
  const kinds = content[1].inline.map((i) => i.i);
  for (
    const kind of ["strong", "em", "del", "code", "link", "image", "break"]
  ) assert(kinds.includes(kind as typeof kinds[number]));
});
Deno.test("markdown preserves Marked setext grammar and long plain paragraphs", () => {
  const text = "x".repeat(2 * 1024 * 1024);
  assertEquals(markdown(text), [{
    b: "paragraph",
    inline: [{ i: "text", text }],
  }]);
  for (
    const source of [
      "Heading\n===\n",
      "Heading\n  ---  \n",
      "Heading\n-",
      "Heading\n=",
      "First\nsecond\n---\n\nDone",
      "Heading\n    ---\n",
      "Heading\n--- extra\n",
      "- list\n  continuation\n",
      "# ATX\n\nparagraph\n",
      "|A|B|\n|--|--|\n|one|two|\n",
      "```\nHeading\n---\n```\n",
      "> Heading\n> ===\n",
    ]
  ) assertEquals(markdown(source), blocks(Lexer.lex(source, { gfm: true })));
});
Deno.test("stream tail equals one-shot parse for 20 random chunkings and late references", () => {
  const texts = [
    "# Heading\n\nWords\n\n- first\n- second\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.",
    "[later][ref]\n\nNext\n\n[ref]: https://example.com\n",
    "# Windows\r\n\r\nText\r\n\r\n```ts\r\nlet x = 1;\r\n```\r\n",
  ];
  for (const text of texts) {
    for (let seed = 1; seed <= 20; seed++) {
      const stream = new StreamingMarkdown();
      let received: Block[] = [], offset = 0, random = seed, prior = 0;
      while (offset < text.length) {
        random = (random * 1664525 + 1013904223) >>> 0;
        const count = 1 + random % 13;
        stream.append(text.slice(offset, offset + count));
        offset += count;
        const op = stream.flush();
        assert(op.from >= prior);
        prior = op.from;
        received = [...received.slice(0, op.from), ...op.blocks];
        assertEquals(received, markdown(stream.text));
      }
      assertEquals(received, markdown(text));
    }
  }
});
