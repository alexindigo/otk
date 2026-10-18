// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapTool } from "../map-tools.ts";
import type { RawPart } from "../types.ts";

Deno.test("recorded native tool envelopes become user results, with complete raw fallback", async () => {
  const parts: RawPart[] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-basic-tools.json",
        import.meta.url,
      ),
    ),
  );
  const result = (part: RawPart) => mapTool(part).outputContent;
  assertEquals(result(parts[1]), {
    kind: "file",
    text: "otk_marker",
    lang: "txt",
    startLine: 2,
    endLine: 2,
    totalLines: 3,
    truncated: true,
  });
  assertEquals(result(parts[2]), {
    kind: "paths",
    paths: [
      parts[2].state!.input.filePath + "/AGENTS.md",
      parts[2].state!.input.filePath + "/probe.txt",
    ],
    offset: 1,
    total: 2,
    truncated: false,
  });
  assertEquals(result(parts[3]), {
    kind: "paths",
    paths: [parts[3].state!.output!],
    truncated: false,
  });
  assertEquals(result(parts[4]), {
    kind: "matches",
    matches: [{ path: parts[3].state!.output!, line: 2, text: "otk_marker" }],
    truncated: false,
  });
  const skill = result(parts[6]) as {
    kind: string;
    text: string;
    paths: string[];
    directory: string;
  };
  assertEquals(skill.kind, "skill");
  assertEquals(skill.text, "Read only this fixture.");
  assertEquals(skill.paths, []);
  assertEquals(skill.directory, parts[6].state!.metadata!.dir);
  for (const index of [1, 2, 3, 4, 6]) {
    const bad = structuredClone(parts[index]);
    bad.state!.output = "Unknown native format\nDo not discard this.";
    assertEquals(result(bad), undefined);
    assertEquals(mapTool(bad).output, bad.state!.output);
  }
  const tasks: { parent: { parts: RawPart[] }[] } = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-tasks.json",
        import.meta.url,
      ),
    ),
  );
  const task = tasks.parent.flatMap((m) => m.parts).find((p) =>
    p.tool === "task"
  )!;
  assertEquals(result(task), { kind: "text", text: "First child completed." });
});
Deno.test("read preserves literal markup and blank lines, native numbering, empty files and capped ranges", () => {
  const read = (body: string, note: string) =>
    mapTool({
      id: "p",
      sessionID: "s",
      messageID: "m",
      type: "tool",
      tool: "read",
      callID: "c",
      state: {
        status: "completed",
        input: { filePath: "/project/probe.py" },
        output:
          `<path>/project/probe.py</path>\n<type>file</type>\n<content>\n${body}\n\n(${note})\n</content>`,
      },
    });
  assertEquals(
    read(
      "7: <content>literal</content>\n8: \n9:   keep spaces  ",
      "Showing lines 7-9 of 12. Use offset=10 to continue.",
    ).outputContent,
    {
      kind: "file",
      text: "<content>literal</content>\n\n  keep spaces  ",
      lang: "python",
      startLine: 7,
      endLine: 9,
      totalLines: 12,
      truncated: true,
    },
  );
  assertEquals(read("", "End of file - total 0 lines").outputContent, {
    kind: "file",
    text: "",
    lang: "python",
    startLine: 1,
    endLine: 0,
    totalLines: 0,
    truncated: false,
  });
  assertEquals(
    read(
      "2: capped",
      "Output capped at 50 KB. Showing lines 2-2. Use offset=3 to continue.",
    ).outputContent,
    {
      kind: "file",
      text: "capped",
      lang: "python",
      startLine: 2,
      endLine: 2,
      totalLines: undefined,
      truncated: true,
    },
  );
  for (
    const call of [
      read("2: keep\n4: noncontiguous", "End of file - total 4 lines"),
      read("2: keep", "Unknown footer"),
    ]
  ) {
    assertEquals(call.outputContent, undefined);
    assertEquals(typeof call.output, "string");
  }
});
