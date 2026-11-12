// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import fixture from "./migrated-history-fixture.json" with { type: "json" };
import { mapTool } from "../map.ts";
import type { NativeMessage } from "../messages.ts";
const tools = (fixture.v2 as unknown as NativeMessage[]).flatMap((m) =>
  m.type === "assistant" ? m.content.filter((p) => p.type === "tool") : []
);
const call = (i: number) => mapTool(tools[i]);
for (
  const [index, path] of [[0, "/fixture/alpha.ts"], [2, "/fixture/beta.ts"], [
    6,
    "/fixture/edit.ts",
  ], [7, "/fixture/new.ts"]] as const
) {
  Deno.test(`migrated tool ${index} retains its file target`, () => {
    const value = call(index);
    assert("path" in value);
    assertEquals(value.path, path);
  });
}
Deno.test("migrated patch keeps typed identity and legacy file metadata", () => {
  const value = call(1);
  assert(value.tool === "patch");
  assertEquals(value.sourceName, "apply_patch");
  assertEquals(value.files.map((f) => f.path), ["/fixture/alpha.ts"]);
  assertEquals(value.files[0].status, "modified");
  assertEquals(value.files[0].additions, 1);
});
Deno.test("migrated failed read keeps path and range", () => {
  const value = call(2);
  assert(value.tool === "read");
  assertEquals([value.path, value.offset, value.limit, value.status], [
    "/fixture/beta.ts",
    190,
    50,
    "error",
  ]);
});
Deno.test("migrated shell and delegate keep working directory and identity", () => {
  const shell = call(3), task = call(4);
  assert(shell.tool === "bash" && task.tool === "task");
  assertEquals(shell.cwd, "/fixture");
  assertEquals(task.agent, "junior");
  assertEquals(task.childSessionID, "opcv2-ses_child");
});
Deno.test("migrated directory read keeps listing identity", () => {
  const value = call(8);
  assert(value.tool === "search");
  assertEquals(value.path, "/fixture/dir");
});
Deno.test("unknown tools present one name without invented detail", () => {
  const value = call(9);
  assert(value.tool === "external");
  assertEquals(value.name, "custom");
  assertNotEquals(value.summary, value.name);
});
