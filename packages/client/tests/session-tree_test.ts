// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry, TaskRecord } from "@otk/protocol";
import { sessionTree } from "../session-tree.ts";
import * as client from "@otk/client";
const entry = (id: string, parentID?: string): IndexEntry => ({
  id,
  title: id,
  directory: "/project",
  projectID: "p",
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "idle",
  digest: { state: "digesting", revision: 0, turns: {} },
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

Deno.test("session family projections preserve ancestry, task order and optional directory semantics", () => {
  const rows = [
    entry("root"),
    entry("middle", "root"),
    entry("leaf", "middle"),
    entry("a", "b"),
    entry("b", "a"),
  ];
  const lookup = (id: string) => rows.find((e) => e.id === id);
  assertEquals(client.sessionFamily("leaf", lookup), [
    "leaf",
    "middle",
    "root",
  ]);
  assertEquals(client.sessionFamily("missing", lookup), ["missing"]);
  assertEquals(
    new Set(client.sessionFamily("a", lookup)).size,
    client.sessionFamily("a", lookup).length,
  );
  const tasks = [
    { ...task("foreign", ["root"]), directory: "/elsewhere" },
    task("middle", ["middle"]),
  ];
  assertEquals(client.familyTask(tasks, ["leaf", "root"])?.id, "foreign");
  assertEquals(
    client.familyTask(tasks, client.sessionFamily("leaf", lookup), "/project")
      ?.id,
    "middle",
  );
  assertEquals(
    client.familyTask(
      [task("root-owner", ["root"]), task("near-owner", ["middle"])],
      client.sessionFamily("leaf", lookup),
      "/project",
    )?.id,
    "near-owner",
    "Inherited membership follows the nearest grouped ancestor, not task order",
  );
  assertEquals(
    client.familySelection({
      sidecarId: "s",
      sessionID: "leaf",
      rootID: "middle",
    }, lookup),
    { sidecarId: "s", sessionID: "leaf", rootID: "root" },
  );
  assertEquals(
    client.familySelection({
      sidecarId: "s",
      sessionID: "missing",
      rootID: "hint",
    }, lookup),
    { sidecarId: "s", sessionID: "missing", rootID: "hint" },
  );
});

Deno.test("hierarchy traverses deep helper chains iteratively with linear parent reads", () => {
  let reads = 0;
  const rows = Array.from({ length: 12000 }, (_, i) => ({
    ...entry(`node-${i}`),
    get parentID() {
      reads++;
      return i ? `node-${i - 1}` : undefined;
    },
  }));
  const groups = sessionTree(rows, [task("chain", ["node-0"])], "/project");
  assertEquals(groups[0].rows.length, rows.length);
  assertEquals(groups[0].rows.at(-1)!.depth, rows.length - 1);
  assertEquals(reads < rows.length * 12, true, `parent reads: ${reads}`);
});

Deno.test("index partitions and hierarchy identity survive summary/status changes", async () => {
  const { createIndex, createSessionTree } = await import("@otk/client");
  const index = createIndex();
  index.receive("s", {
    t: "index.snapshot",
    rev: 1,
    entries: [entry("one"), { ...entry("two"), directory: "/other" }],
  });
  const keys = index.ids("s", "/project"), other = index.ids("s", "/other");
  const tree = createSessionTree();
  const first = tree.rows(index.partition("s", "/project"), [], "/project");
  index.receive("s", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "upsert", entry: { ...entry("one"), status: "busy" } }],
  });
  assertEquals(index.ids("s", "/project") === keys, true);
  assertEquals(index.ids("s", "/other") === other, true);
  assertEquals(
    tree.rows(index.partition("s", "/project"), [], "/project") === first,
    true,
  );
  index.receive("s", {
    t: "index.patch",
    rev: 3,
    ops: [{ op: "upsert", entry: { ...entry("one"), directory: "/other" } }],
  });
  assertEquals(index.ids("s", "/project"), []);
  assertEquals(index.ids("s", "/other"), ["two", "one"]);
  assertEquals(index.partition("s").map((e) => e.id), ["one", "two"]);
  index.receive("s", {
    t: "index.snapshot",
    rev: 4,
    entries: [{ ...entry("one"), directory: "/other" }, {
      ...entry("two"),
      directory: "/other",
    }],
  });
  assertEquals(index.ids("s", "/other"), ["one", "two"]);
  index.remove("s");
  assertEquals(index.ids("s"), []);
});
