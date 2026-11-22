// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";
import { projectSessionHierarchy } from "@otk/protocol";
import { createTabs as canonicalTabs, projectTabGroups } from "@otk/client";
import { createTabs, projected } from "./supervision-fixture.ts";

const entry = (
  id: string,
  parentID?: string,
  directory = "/p",
): IndexEntry => ({
  id,
  parentID,
  directory,
  projectID: "p",
  title: id,
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
});
const task = (
  id: string,
  sessions: string[],
  directory = "/p",
): TaskRecord => ({
  id,
  sessions,
  directory,
  name: id,
  order: 0,
});
const inbox = (tasks: TaskRecord[] = []): InboxSnapshot => ({
  tasks,
  projects: [],
  seen: {},
  finishes: {},
  pathTemplates: [],
});
const model = () => createTabs(() => Promise.reject(Error("No promotion")));
const owned = (tabs: ReturnType<typeof model>, ids: string[]) =>
  Object.fromEntries(
    tabs.tabs().map((tab) => [
      tab.id,
      ids.filter((id) => tabs.belongsToTab(tab.id, id)),
    ]),
  );

Deno.test("tab groups row 1: sibling phantoms own disjoint trails and quiet viewing stays with its ancestor", () => {
  const rows = [entry("R"), entry("A", "R"), entry("B", "R"), entry("C", "R")];
  for (const row of rows.slice(0, 3)) row.status = "busy";
  const tabs = model();
  try {
    tabs.update({ directory: "/p", entries: rows, inbox: inbox() });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R", "C"],
      A: ["A"],
      B: ["B"],
    });
    for (const id of ["R", "A", "B"]) {
      tabs.select({ kind: "session", id });
      assertEquals(tabs.state.selected, { kind: "session", id });
      assertEquals(
        tabs.crumbs().filter((crumb) => !crumb.external).map((crumb) =>
          crumb.id
        ),
        [id],
      );
      assertEquals(
        tabs.crumbs().filter((crumb) => crumb.external).map((crumb) =>
          crumb.id
        ),
        id === "R" ? [] : ["R"],
      );
    }
    tabs.preview("C");
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R", "C"]);
    tabs.select({ kind: "session", id: "R" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R"]);
  } finally {
    tabs.stop();
  }
});

Deno.test("tab groups row 2: an explicit child task has an ancestor link, never a second membership", () => {
  const rows = [entry("X"), entry("Y", "X")],
    tasks = [task("T1", ["X"]), task("T2", ["Y"])];
  rows[1].status = "busy";
  const tabs = model();
  try {
    tabs.update({ directory: "/p", entries: rows, inbox: inbox(tasks) });
    assertEquals(owned(tabs, ["X", "Y"]), { T1: ["X"], T2: ["Y"] });
    tabs.select({ kind: "task", id: "T1" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["X"]);
    tabs.select({ kind: "task", id: "T2" });
    assertEquals(tabs.crumbs().map((crumb) => [crumb.id, !!crumb.external]), [[
      "X",
      true,
    ], ["Y", false]]);
  } finally {
    tabs.stop();
  }
});

Deno.test("tab groups row 3: metadata, reload, promotion, close and checkout toggles preserve the partition", () => {
  const rows = [entry("R"), entry("A", "R"), entry("B", "R"), entry("C", "A")];
  for (const row of rows.slice(0, 3)) row.status = "busy";
  const meta = inbox(), tabs = model();
  const update = () =>
    tabs.update({ directory: "/p", entries: rows, inbox: meta });
  try {
    update();
    tabs.preview("A");
    rows[1].title = "Updated A";
    update();
    assertEquals(tabs.state.selected, { kind: "session", id: "A" });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R"],
      A: ["A", "C"],
      B: ["B"],
    });
    const fresh = model();
    fresh.update({ directory: "/p", entries: rows, inbox: meta });
    fresh.preview("A");
    assertEquals(fresh.crumbs(), tabs.crumbs());
    fresh.stop();
    meta.tasks = [task("T", ["A"])];
    update();
    assertEquals(tabs.state.selected, { kind: "task", id: "T" });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      T: ["A", "C"],
      R: ["R"],
      B: ["B"],
    });
    meta.tasks = [];
    update();
    assertEquals(tabs.state.selected, { kind: "session", id: "A" });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R"],
      A: ["A", "C"],
      B: ["B"],
    });
    const parent = entry("P", undefined, "/other"), child = entry("L", "P");
    const foreign = [parent, child], saved = [task("foreign", ["P"], "/other")];
    for (const followParent of [false, true]) {
      for (const wire of [false, true]) {
        const nodes = projectSessionHierarchy(foreign, saved, { followParent });
        const context = foreign.map((row) => ({
          ...row,
          ...(wire ? { hierarchy: nodes.get(row.id) } : {}),
        }));
        tabs.update({
          directory: "/p",
          entries: [context[1]],
          context,
          followParent,
          inbox: { ...inbox(saved), ...projected(foreign, inbox(saved)) },
        });
        tabs.preview("L");
        assertEquals(tabs.state.selected, {
          kind: followParent ? "task" : "session",
          id: followParent ? "foreign" : "L",
        });
        assertEquals(
          tabs.crumbs().map((crumb) => [crumb.id, !!crumb.external]),
          [["P", true], ["L", false]],
        );
        assertEquals(tabs.belongsToTab(tabs.state.selected!.id, "L"), true);
      }
    }
  } finally {
    tabs.stop();
  }
});

Deno.test("presentation partition covers cycles, missing parents and nested tasks exactly once with wire parity", () => {
  const rows = [
    entry("R"),
    entry("A", "R"),
    entry("B", "A"),
    entry("C", "B"),
    entry("orphan", "missing"),
    entry("U", "V"),
    entry("V", "U"),
  ];
  const saved = [task("parent", ["R"]), task("child", ["B"])];
  const mandatory = new Set(["A", "V", "orphan"]);
  let expected: unknown;
  for (const wire of [false, true]) {
    const hierarchy = projectSessionHierarchy(rows, saved);
    const result = projectTabGroups(rows, saved, {
      mandatory,
      hierarchy: wire ? hierarchy : undefined,
    });
    const all = result.groups.flatMap((group) => group.members);
    assertEquals(all.length, new Set(all).size);
    assertEquals(all.toSorted(), rows.map((row) => row.id).toSorted());
    for (const group of result.groups) {
      assertEquals(
        group.ancestorLinks.some((id) => group.members.includes(id)),
        false,
      );
      for (const id of group.members) {
        assertEquals(result.owners.get(id), group);
      }
    }
    const snapshot = result.groups.map((
      group,
    ) => [group.kind, group.id, group.members]);
    if (!wire) expected = snapshot;
    else assertEquals(snapshot, expected);
    assertEquals(result.owners.get("A")?.id, "parent");
    assertEquals(result.owners.get("C")?.id, "child");
    assertEquals(result.owners.get("U")?.id, "V");
  }
});

Deno.test("current inbox membership wins over independently arriving stale wire task ownership", () => {
  const rows = [entry("R"), entry("A", "R"), entry("C", "A")];
  const old = projectSessionHierarchy(rows, []);
  const context = rows.map((row) => ({ ...row, hierarchy: old.get(row.id) }));
  const meta = inbox();
  meta.supervision = {
    A: { state: "working", terminal: 0 },
    C: { state: "working", terminal: 0 },
  };
  const tabs = canonicalTabs(() => Promise.reject(Error("No promotion")));
  const update = () =>
    tabs.update({ directory: "/p", entries: context, inbox: meta });
  try {
    update();
    tabs.preview("A");
    meta.tasks = [task("T", ["A"])];
    update();
    assertEquals(tabs.state.selected, { kind: "task", id: "T" });
    assertEquals(tabs.belongsToTab("T", "C"), true);
    assertEquals(tabs.tabs().map((tab) => tab.id), ["T"]);
    const grouped = projectSessionHierarchy(rows, meta.tasks);
    context.forEach((row) => row.hierarchy = grouped.get(row.id));
    meta.tasks = [];
    update();
    assertEquals(tabs.state.selected, { kind: "session", id: "A" });
    assertEquals(tabs.tabs().map((tab) => tab.id).toSorted(), ["A", "C"]);
    assertEquals(
      tabs.crumbs().filter((crumb) => crumb.kind === "member").map((crumb) =>
        crumb.id
      ),
      ["A"],
    );
  } finally {
    tabs.stop();
  }
});

for (
  const state of [
    "working",
    "needsYou",
    "finishedUnseen",
    "dependencies",
  ] as const
) {
  Deno.test(`independent phantom ${state} owns its lamp, survives selection and retires only after departure`, () => {
    const rows = [entry("R"), entry("A", "R"), entry("C", "A")];
    const meta = inbox();
    meta.supervision = {
      A: {
        state: state === "dependencies" ? "none" : state,
        terminal: 1,
        ...(state === "dependencies" ? { dependencies: { running: 1 } } : {}),
      },
    };
    const tabs = canonicalTabs(() => Promise.reject(Error("No promotion")));
    const update = () =>
      tabs.update({ directory: "/p", entries: rows, inbox: meta });
    try {
      update();
      tabs.preview("A");
      assertEquals(tabs.state.selected, { kind: "session", id: "A" });
      assertEquals(tabs.belongsToTab("A", "C"), true);
      assertEquals(tabs.crumbs().map((crumb) => [crumb.id, crumb.kind]), [[
        "R",
        "ancestor",
      ], ["A", "member"]]);
      meta.supervision = {};
      update();
      assertEquals(tabs.state.selected, { kind: "session", id: "A" });
      tabs.preview("R");
      assertEquals(tabs.tabs().map((tab) => tab.id), ["R"]);
      assertEquals(tabs.belongsToTab("R", "A"), true);
      assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R"]);
    } finally {
      tabs.stop();
    }
  });
}
