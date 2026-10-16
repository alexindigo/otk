// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry, TaskRecord } from "@otk/protocol";
import { sessionTree } from "../session-tree.ts";
const entry = (id: string, parentID?: string): IndexEntry => ({
  id,
  title: id,
  directory: "/project",
  projectID: "p",
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
  ...(parentID ? { parentID } : {}),
});
const task = (id: string, sessions: string[], order = 0): TaskRecord => ({
  id,
  name: id,
  directory: "/project",
  sessions,
  order,
});
Deno.test("session tree preserves task order, parent-child paths and nearest explicit ownership without duplicating helpers", () => {
  const entries = [
    entry("root"),
    entry("helper", "root"),
    entry("nested", "helper"),
    entry("other"),
    entry("orphan", "missing"),
    { ...entry("foreign"), directory: "/other" },
  ];
  const result = sessionTree(entries, [
    task("second", ["other"], 1),
    task("first", ["root"]),
  ], "/project");
  assertEquals(
    result.map((g) => [g.title, g.rows.map((r) => [r.session.id, r.depth])]),
    [
      ["first", [["root", 0], ["helper", 1], ["nested", 2]]],
      ["second", [["other", 0]]],
      ["Not in a task", [["orphan", 0]]],
    ],
  );
  assertEquals(
    sessionTree(entries, [
      task("root task", ["root"]),
      task("helper task", ["helper"], 1),
    ], "/project").map((g) => g.rows.map((r) => r.session.id)),
    [["root"], ["helper", "nested"], ["other", "orphan"]],
  );
});
Deno.test("session title search retains matching ancestry, excludes unrelated descendants and never hides cyclic or missing-parent rows", () => {
  const entries = [
    entry("root"),
    entry("Helper", "root"),
    entry("nested", "Helper"),
    entry("cycle-a", "cycle-b"),
    entry("cycle-b", "cycle-a"),
    entry("orphan", "missing"),
  ];
  const tasks = [task("task", ["root"])];
  assertEquals(
    sessionTree(entries, tasks, "/project", " hELpER ").map((g) =>
      g.rows.map((r) => r.session.id)
    ),
    [["root", "Helper"]],
  );
  assertEquals(
    sessionTree(entries, tasks, "/project", "nested")[0].rows.map((r) =>
      r.depth
    ),
    [0, 1, 2],
  );
  assertEquals(sessionTree(entries, tasks, "/project", "nothing"), []);
  assertEquals(
    sessionTree(entries, tasks, "/project").flatMap((g) =>
      g.rows.map((r) => r.session.id)
    ).sort(),
    entries.map((e) => e.id).sort(),
  );
});
