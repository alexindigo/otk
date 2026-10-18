// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapTool } from "../map-tools.ts";
import type { RawPart } from "../types.ts";
function search(
  tool: string,
  output?: string,
  metadata: Record<string, unknown> = {},
) {
  const raw: RawPart = {
    id: "part",
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: "call",
    tool,
    state: {
      status: "completed",
      input: { filePath: "/project/src" },
      output,
      metadata,
    },
  };
  return mapTool(raw);
}
Deno.test("native path-list results carry paths and pagination metadata without model envelopes", () => {
  const output =
    "/project/src/a.ts\n/project/src/b.ts\n\n(Results are truncated: showing first 2 results.)";
  assertEquals(search("glob", output).outputContent, {
    kind: "paths",
    paths: ["/project/src/a.ts", "/project/src/b.ts"],
    truncated: true,
  });
  assertEquals(search("glob", output).output, output);
  assertEquals(search("list", "/project/a\n/project/b").outputContent, {
    kind: "paths",
    paths: ["/project/a", "/project/b"],
    truncated: false,
  });
  const directory =
    "<path>/project/src</path>\n<type>directory</type>\n<entries>\na.ts\nsub/\n\n(Showing 2 of 3 entries. Use 'offset' parameter to read beyond entry 3)\n</entries>";
  assertEquals(
    search("read", directory, {
      display: {
        type: "directory",
        path: "/project/src",
        entries: ["a.ts", "sub/"],
        offset: 1,
        totalEntries: 3,
        truncated: true,
      },
    }).outputContent,
    {
      kind: "paths",
      paths: ["/project/src/a.ts", "/project/src/sub/"],
      offset: 1,
      total: 3,
      truncated: true,
    },
  );
  const empty =
    "<path>/project/src</path>\n<type>directory</type>\n<entries>\n\n\n(0 entries)\n</entries>";
  assertEquals(
    search("read", empty, {
      display: {
        type: "directory",
        path: "/project/src",
        entries: [],
        offset: 1,
        totalEntries: 0,
        truncated: false,
      },
    }).outputContent,
    { kind: "paths", paths: [], offset: 1, total: 0, truncated: false },
  );
  for (const tool of ["grep", "glob"]) {
    assertEquals(
      search(tool, "No files found").outputContent,
      tool === "grep"
        ? { kind: "matches", matches: [], truncated: false }
        : { kind: "paths", paths: [], truncated: false },
    );
  }
});
Deno.test("unrecognized, malformed and absent results fall back without losing any text", () => {
  for (const tool of ["glob", "list", "grep", "read"]) {
    for (
      const output of [
        undefined,
        "",
        "unknown format\n/project/a.ts",
        "/project/a\n\nunknown notice\n\nextra",
        "Found 1 matches\n/project/a:\n  Line 1: keep me\n/project/unmatched:",
      ]
    ) {
      const call = search(tool, output);
      assertEquals(call.output, output);
      assertEquals(call.outputContent, undefined, `${tool}: ${output}`);
    }
  }
  assertEquals(
    search("read", "Unrecognized directory output", {
      display: { type: "directory", path: "/project", entries: ["a", 5] },
    }).outputContent,
    undefined,
  );
});
Deno.test("grep paths, line numbers, literal markup and truncation metadata are decoded once", () => {
  const output =
    "Found 2 matches (more matches available)\n/project/a.ts:\n  Line 9:   <content>literal</content>\n\n/project/b.ts:\n  Line 17: second\n\n(Results truncated. Consider using a more specific path or pattern.)";
  assertEquals(search("grep", output).outputContent, {
    kind: "matches",
    matches: [{
      path: "/project/a.ts",
      line: 9,
      text: "  <content>literal</content>",
    }, { path: "/project/b.ts", line: 17, text: "second" }],
    truncated: true,
  });
});
