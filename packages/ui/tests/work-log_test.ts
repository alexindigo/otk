// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Part } from "@otk/protocol";
import { DEFAULT_PREFS } from "@otk/protocol";
import { PartRegistry } from "../registries/renderers.ts";
import { partGroups } from "../components/work-log.ts";
import { relativeTarget } from "../components/tools/paths.ts";
import { blocksText } from "../components/parts/text.ts";

Deno.test("work groups preserve ordering, external ownership, missing clocks and consumer isolation", () => {
  const registry = new PartRegistry(), other = new PartRegistry();
  registry.register(
    "step",
    () => "step",
    (part) => ({ work: JSON.parse(part.data!) }),
  );
  const input: Part[] = [
    { id: "a", kind: "text", blocks: [], synthetic: false },
    { id: "b", kind: "external", name: "step", data: '{"start":10,"end":20}' },
    { id: "c", kind: "external", name: "step", data: '{"start":15,"end":30}' },
    { id: "d", kind: "text", blocks: [], synthetic: false },
    { id: "e", kind: "external", name: "step", data: '{"start":40}' },
  ];
  const groups = partGroups(
    input,
    (part) => registry.presentation(part, DEFAULT_PREFS),
  );
  assertEquals(
    groups.map((group) => [group.work, group.parts.map((part) => part.id)]),
    [[false, ["a"]], [true, ["b", "c"]], [false, ["d"]], [true, ["e"]]],
  );
  assertEquals(groups[1].time, { start: 10, end: 30 });
  assertEquals(groups[3].time, { start: 40 });
  assertEquals(
    partGroups(input, (part) => other.presentation(part, DEFAULT_PREFS))
      .length,
    5,
  );
  assertEquals(input.map((part) => part.id), ["a", "b", "c", "d", "e"]);
});
Deno.test("path targets are lexical project-relative paths without corrupting prefixes or nonpaths", () => {
  for (
    const [path, directory, expected] of [
      ["/work/project/src/a.ts", "/work/project", "src/a.ts"],
      ["/work/project-old/a.ts", "/work/project/", "../project-old/a.ts"],
      ["/work/project/../outside/a.ts", "/work/project/.", "../outside/a.ts"],
      ["/work/project", "/work/project", "."],
      ["src/a.ts", "/work/project", "src/a.ts"],
      ["https://example.test/a", "/work/project", "https://example.test/a"],
      ["/work/project/a", undefined, "/work/project/a"],
    ]
  ) assertEquals(relativeTarget(path!, directory), expected);
});
Deno.test("copy text uses source blocks including rich inline, lists, code and tables", () => {
  assertEquals(
    blocksText([
      {
        b: "paragraph",
        inline: [
          { i: "text", text: "Hello " },
          { i: "strong", inline: [{ i: "text", text: "world" }] },
          { i: "break" },
          { i: "image", src: "file", alt: "diagram" },
        ],
      },
      {
        b: "list",
        ordered: false,
        items: [{
          blocks: [{
            b: "paragraph",
            inline: [{ i: "code", text: "source.ts" }],
          }],
        }],
      },
      { b: "code", text: "const x = 1;" },
      {
        b: "table",
        align: [null],
        header: [[{ i: "text", text: "Name" }]],
        rows: [[[{ i: "text", text: "OTK" }]]],
      },
    ]),
    "Hello world\ndiagram\n\nsource.ts\n\nconst x = 1;\n\nName\nOTK",
  );
});
