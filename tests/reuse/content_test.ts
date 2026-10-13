// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { markdown, parseDiff, StreamingMarkdown } from "@otk/content";

Deno.test("standalone content consumer converts markdown and patches without app dependencies", () => {
  assertEquals(markdown("# Reusable content\n\n**Standalone** consumer."), [
    {
      b: "heading",
      level: 1,
      inline: [{ i: "text", text: "Reusable content" }],
    },
    {
      b: "paragraph",
      inline: [
        { i: "strong", inline: [{ i: "text", text: "Standalone" }] },
        { i: "text", text: " consumer." },
      ],
    },
  ]);
  assertEquals(
    parseDiff("--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    [{
      path: "example.ts",
      oldPath: undefined,
      status: "modified",
      additions: 1,
      deletions: 1,
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "del", text: "old", oldNo: 1 },
          { kind: "add", text: "new", newNo: 1 },
        ],
      }],
    }],
  );
  const stream = new StreamingMarkdown("# Reusable content\n\n");
  let received = stream.flush().blocks;
  stream.append("A streamed paragraph.");
  const update = stream.flush();
  received = [...received.slice(0, update.from), ...update.blocks];
  assertEquals(received, markdown(stream.text));
});
