// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { mapTool } from "../map-tools.ts";
import type { RawPart } from "../types.ts";
Deno.test("recorded opencode 1.18.34 todo and question calls become OTK shapes", async () => {
  const parts: RawPart[] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-todo-question.json",
        import.meta.url,
      ),
    ),
  );
  const todo = mapTool(parts[0]);
  assert(todo.tool === "todo");
  assertEquals(todo.items.map((item) => [item.content, item.status]), [
    ["pending item", "pending"],
    ["in_progress item", "in_progress"],
    ["completed item", "completed"],
    ["cancelled item", "cancelled"],
  ]);
  const question = mapTool(parts[1]);
  assert(question.tool === "question");
  assertEquals(question.questions, [{
    text: "Which rendering?",
    options: [{ label: "Typed", description: "OTK shapes" }, {
      label: "Raw",
      description: "Harness types",
    }],
    answer: ["Typed"],
  }]);
  for (const call of [todo, question]) {
    assertEquals(call.status, "completed");
    for (
      const field of [
        "metadata",
        "state",
        "input",
        "sessionId",
        "subagent_type",
      ]
    ) assert(!JSON.stringify(call).includes(`"${field}"`));
  }
});
Deno.test("recorded file tools map hunks, status, paths and one-based file-local diagnostics", async () => {
  const raw: RawPart[] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-file-tools.json",
        import.meta.url,
      ),
    ),
  );
  const [edit, write, patch] = raw.map((part) => mapTool(part));
  assert(
    edit.tool === "edit" && write.tool === "write" && patch.tool === "patch",
  );
  assertEquals(
    edit.files[0].hunks[0].lines.map(
      (line) => [line.kind, line.oldNo, line.newNo],
    ),
    [["del", 1, undefined], ["add", undefined, 1]],
  );
  assertEquals(edit.diagnostics, [{
    severity: "error",
    line: 1,
    col: 3,
    message: "fixture diagnostic",
  }]);
  assertEquals(write.content, "const written: number = 2;\n");
  assertEquals(write.lang, "ts");
  assertEquals(write.diagnostics.length, 1);
  assertEquals(patch.files.map((file) => file.status), [
    "added",
    "modified",
    "deleted",
    "moved",
  ]);
  assertEquals(patch.files.map((file) => [file.additions, file.deletions]), [
    [1, 0],
    [1, 1],
    [0, 1],
    [1, 1],
  ]);
  assert(
    patch.files[3].oldPath?.endsWith("move.txt") &&
      patch.files[3].path.endsWith("moved.txt"),
  );
  assertEquals(patch.files[0].diagnostics?.[0].col, 3);
  for (const call of [edit, write, patch]) {
    for (
      const field of ["metadata", "state", "input", "filePath", "patchText"]
    ) assert(!(field in call));
  }
});
Deno.test("recorded basic tools retain OTK fields, actual search counts and denied/error states", async () => {
  const raw: RawPart[] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-basic-tools.json",
        import.meta.url,
      ),
    ),
  );
  const calls = raw.map((part) => mapTool(part));
  assertEquals(calls.map((call) => call.tool), [
    "bash",
    "read",
    "search",
    "search",
    "search",
    "fetch",
    "skill",
    "generic",
    "bash",
    "websearch",
    "read",
  ]);
  const [
    bash,
    read,
    list,
    glob,
    grep,
    fetch,
    skill,
    generic,
    denied,
    websearch,
    error,
  ] = calls;
  assert(
    bash.tool === "bash" && read.tool === "read" && list.tool === "search" &&
      glob.tool === "search" && grep.tool === "search" &&
      fetch.tool === "fetch" && skill.tool === "skill" &&
      generic.tool === "generic" && websearch.tool === "websearch",
  );
  assertEquals(bash.output.trimEnd().split("\n").length, 30);
  assertEquals(bash.exitCode, 0);
  assertEquals([read.offset, read.limit, read.loaded.length], [2, 1, 1]);
  assertEquals([
    list.mode,
    list.matches,
    glob.mode,
    glob.matches,
    grep.mode,
    grep.matches,
  ], ["list", 2, "glob", 1, "grep", 1]);
  assertEquals(fetch.format, "text");
  assertEquals(skill.name, "otk-fixture");
  assertEquals(generic.output, "first\nsecond\nthird\nfourth\nfifth");
  assertEquals([denied.status, websearch.status, error.status], [
    "denied",
    "denied",
    "error",
  ]);
  assertEquals(websearch.provider, "exa");
  assert(!("results" in websearch));
  for (const call of calls) {
    for (const field of ["metadata", "state", "input", "sessionId"]) {
      assert(!(field in call));
    }
  }
  const ansi = structuredClone(raw[0]);
  ansi.state!.metadata!.output = "\u001b[31mred\u001b[0m";
  const stripped = mapTool(ansi);
  assert(stripped.tool === "bash");
  assertEquals(stripped.output, "red");
  const large = structuredClone(raw[7]);
  large.state!.output = "x".repeat(70000);
  const capped = mapTool(large);
  assert(capped.tool === "generic");
  assertEquals(capped.output?.length, 65536);
  assertEquals(capped.outputTruncated, true);
  large.state!.output = "é".repeat(40000);
  const unicode = mapTool(large);
  assert(unicode.tool === "generic");
  assertEquals(new TextEncoder().encode(unicode.output).length, 65536);
  assert(!unicode.output!.includes("�"));
});
