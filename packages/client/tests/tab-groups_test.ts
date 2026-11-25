// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";
import { projectSessionHierarchy } from "@otk/protocol";
import {
  createTabs as canonicalTabs,
  projectTabGroups,
  taskBreadcrumbs,
} from "@otk/client";
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

Deno.test("tab groups row 1: sibling helpers share one human group and quiet viewing stays with its ancestor", () => {
  const rows = [entry("R"), entry("A", "R"), entry("B", "R"), entry("C", "R")];
  for (const row of rows.slice(0, 3)) row.status = "busy";
  const tabs = model();
  try {
    tabs.update({ directory: "/p", entries: rows, inbox: inbox() });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R", "A", "B", "C"],
    });
    for (const id of ["R", "A", "B"]) {
      tabs.preview(id);
      assertEquals(tabs.state.selected, { kind: "session", id: "R" });
      assertEquals(
        tabs.crumbs().filter((crumb) => !crumb.external).map((crumb) =>
          crumb.id
        ),
        id === "B" ? ["R", "B", "A"] : ["R", "A", "B"],
      );
      assertEquals(
        tabs.crumbs().filter((crumb) => crumb.external).map((crumb) =>
          crumb.id
        ),
        [],
      );
    }
    tabs.preview("C");
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R", "C", "A", "B"]);
    tabs.select({ kind: "session", id: "R" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R", "A", "B"]);
  } finally {
    tabs.stop();
  }
});

Deno.test("tab groups row 2: legacy child tasks cannot split human membership", () => {
  const rows = [entry("X"), entry("Y", "X")],
    tasks = [task("T1", ["X"]), task("T2", ["Y"])];
  rows[1].status = "busy";
  const tabs = model();
  try {
    tabs.update({ directory: "/p", entries: rows, inbox: inbox(tasks) });
    assertEquals(owned(tabs, ["X", "Y"]), { T1: ["X", "Y"] });
    tabs.select({ kind: "task", id: "T1" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["X", "Y"]);
    tabs.preview("Y");
    assertEquals(tabs.crumbs().map((crumb) => [crumb.id, !!crumb.external]), [[
      "X",
      false,
    ], ["Y", false]]);
  } finally {
    tabs.stop();
  }
});

Deno.test("2.67 helper-only saved groups render no task tab", () => {
  const rows = [entry("R"), entry("H", "R")];
  const tabs = model();
  try {
    tabs.update({
      directory: "/p",
      entries: rows,
      inbox: inbox([task("helper-only", ["H"])]),
    });
    tabs.preview("H");
    assertEquals(tabs.tabs().map((tab) => [tab.kind, tab.id]), [[
      "phantom",
      "R",
    ]]);
    assertEquals(tabs.tasks(), []);
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(tabs.state.sessionID, "H");
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
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R", "A", "B", "C"],
    });
    const fresh = model();
    fresh.update({ directory: "/p", entries: rows, inbox: meta });
    fresh.preview("A");
    assertEquals(fresh.crumbs(), tabs.crumbs());
    fresh.stop();
    meta.tasks = [task("T", ["A"])];
    update();
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R", "A", "B", "C"],
    });
    meta.tasks = [];
    update();
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(owned(tabs, rows.map((row) => row.id)), {
      R: ["R", "A", "B", "C"],
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
          id: followParent ? "foreign" : "P",
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

Deno.test("presentation partition never promotes cycles or missing parents and keeps rooted helpers exactly once with wire parity", () => {
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
    assertEquals(all.toSorted(), ["A", "B", "C", "R"]);
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
    assertEquals(result.owners.get("C")?.id, "parent");
    assertEquals(result.owners.has("U"), false);
    assertEquals(result.owners.has("orphan"), false);
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
    meta.tasks = [task("T", ["R"])];
    update();
    assertEquals(tabs.state.selected, { kind: "task", id: "T" });
    assertEquals(tabs.belongsToTab("T", "C"), true);
    assertEquals(tabs.tabs().map((tab) => tab.id), ["T"]);
    const grouped = projectSessionHierarchy(rows, meta.tasks);
    context.forEach((row) => row.hierarchy = grouped.get(row.id));
    meta.tasks = [];
    update();
    assertEquals(tabs.state.selected, { kind: "session", id: "R" });
    assertEquals(tabs.tabs().map((tab) => tab.id).toSorted(), ["R"]);
    assertEquals(
      tabs.crumbs().filter((crumb) => crumb.kind === "member").map((crumb) =>
        crumb.id
      ),
      ["R", "A", "C"],
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
  ] as const
) {
  Deno.test(`human group rolls up helper ${state}, survives selection and retires only after departure`, () => {
    const rows = [entry("R"), entry("A", "R"), entry("C", "A")];
    const meta = inbox();
    meta.supervision = {
      A: {
        state,
        terminal: 1,
      },
    };
    const tabs = canonicalTabs(() => Promise.reject(Error("No promotion")));
    const update = () =>
      tabs.update({ directory: "/p", entries: rows, inbox: meta });
    try {
      update();
      tabs.preview("A");
      assertEquals(tabs.state.selected, { kind: "session", id: "R" });
      const phantom = tabs.tabs().find((tab) => tab.id === "R")!;
      assertEquals(
        phantom.status,
        state === "needsYou"
          ? "blocked"
          : state === "finishedUnseen"
          ? "finished"
          : state,
      );
      assertEquals(tabs.belongsToTab("R", "C"), true);
      assertEquals(tabs.crumbs().map((crumb) => [crumb.id, crumb.kind]), [[
        "R",
        "member",
      ], ["A", "member"]]);
      meta.supervision = {};
      update();
      assertEquals(tabs.state.selected, { kind: "session", id: "R" });
      tabs.preview("R");
      assertEquals(tabs.tabs().map((tab) => tab.id), ["R"]);
      assertEquals(tabs.belongsToTab("R", "A"), true);
      assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R"]);
    } finally {
      tabs.stop();
    }
  });
}

Deno.test("review: foreign task defaults use projected roots or members before any preview", () => {
  const rows = [
    entry("P", undefined, "/other"),
    entry("L1", "P"),
    entry("L2", "P"),
  ];
  for (const sessions of [["P"], ["P", "L2"]]) {
    const saved = [task("foreign", sessions, "/other")];
    for (const wire of [false, true]) {
      const nodes = projectSessionHierarchy(rows, saved, {
        followParent: true,
      });
      const context = rows.map((row) => ({
        ...row,
        ...(wire ? { hierarchy: nodes.get(row.id) } : {}),
      }));
      const tabs = model();
      const update = (remaining = context.slice(1)) =>
        tabs.update({
          directory: "/p",
          entries: remaining,
          context: [context[0], ...remaining],
          followParent: true,
          inbox: inbox(saved),
        });
      try {
        update();
        const first = sessions.includes("L2") ? "L2" : "L1";
        assertEquals(tabs.sessionFor("foreign"), first);
        tabs.select({ kind: "task", id: "foreign" });
        assertEquals(tabs.state.sessionID, first);
        assertEquals(tabs.belongsToTab("foreign", "P"), false);
        assertThrows(
          () => tabs.select({ kind: "task", id: "foreign" }, "P"),
          Error,
          "Unknown task session",
        );
        tabs.preview("L1");
        assertEquals(tabs.sessionFor("foreign"), "L1");
        update([context[2]]);
        assertEquals(tabs.sessionFor("foreign"), "L2");
        tabs.select({ kind: "task", id: "foreign" });
        assertEquals(tabs.state.sessionID, "L2");
      } finally {
        tabs.stop();
      }
    }
  }
});

Deno.test("review: sparse hierarchy cannot create absent phantoms but keeps reserved task inheritance", () => {
  const rows = [entry("C", "P")];
  const hierarchy = new Map();
  const orphan = projectTabGroups(rows, [], { hierarchy });
  assertEquals(orphan.owners.get("C"), undefined);
  assertEquals(orphan.owners.has("P"), false);
  assertEquals(orphan.groups, []);
  const reserved = projectTabGroups(rows, [task("T", ["P"])], { hierarchy });
  assertEquals(reserved.owners.get("C")?.id, "T");
  assertEquals(reserved.groups.map((group) => group.members), [["P", "C"]]);
});

Deno.test("review: reserved parent inheritance survives populated hierarchy and checkout scoping", () => {
  const rows = [entry("C", "P")];
  for (const directory of [undefined, "/p"]) {
    const saved = [task("T", ["P"])];
    const nodes = projectSessionHierarchy(rows, saved);
    for (const hierarchy of [undefined, new Map(), nodes]) {
      const result = projectTabGroups(rows, saved, { directory, hierarchy });
      assertEquals(result.owners.get("C")?.id, "T");
      assertEquals(result.groups.map((group) => group.members), [["P", "C"]]);
    }
    const foreign = [task("foreign", ["P"], "/other")];
    for (
      const hierarchy of [
        undefined,
        new Map(),
        projectSessionHierarchy(rows, foreign),
      ]
    ) {
      const result = projectTabGroups(rows, foreign, { directory, hierarchy });
      assertEquals(result.owners.get("C"), undefined);
    }
  }
  const catalog = [entry("P", undefined, "/other"), ...rows];
  assertEquals(
    projectTabGroups(catalog, [], { hierarchy: new Map() }).owners.get("C")?.id,
    undefined,
  );
  const nested = projectTabGroups(rows, [task("nested", ["P"], "/p/src")], {
    directory: "/p",
    directories: ["/p", "/p/src"],
  });
  assertEquals(nested.owners.get("C")?.id, "nested");
});

Deno.test("review: standalone crumbs and top-line tabs share hierarchy-only mandatory evidence", () => {
  const rows = [entry("R"), entry("C", "R")], saved = [task("T", ["R"])];
  const nodes = projectSessionHierarchy(rows, saved, {
    mandatory: (id) => id === "C",
  });
  const context = rows.map((row) => ({ ...row, hierarchy: nodes.get(row.id) }));
  const meta = inbox(saved);
  const tabs = canonicalTabs(() => Promise.reject(Error("No promotion")));
  try {
    tabs.update({ directory: "/p", entries: context, inbox: meta });
    tabs.select({ kind: "task", id: "T" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R", "C"]);
    for (
      const [entries, projection] of [[context, undefined], [
        rows,
        nodes,
      ], [
        [rows[0], context[1]],
        undefined,
      ], [
        rows,
        new Map([["C", nodes.get("C")!]]),
      ]] as const
    ) {
      assertEquals(
        taskBreadcrumbs(
          saved[0],
          entries,
          saved,
          undefined,
          meta,
          false,
          projection,
        ),
        tabs.crumbs(),
      );
    }
    const mismatched = [context[0], {
      ...context[1],
      hierarchy: { ...context[1].hierarchy!, followParent: true },
    }];
    tabs.update({ directory: "/p", entries: mismatched, inbox: meta });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R"]);
    assertEquals(
      taskBreadcrumbs(saved[0], mismatched, saved, undefined, meta),
      tabs.crumbs(),
    );
  } finally {
    tabs.stop();
  }
});

Deno.test("answer 1: quiet intermediate members retire even on the open member's ancestry", () => {
  const rows = [entry("R"), entry("Q", "R"), entry("C", "Q"), entry("S", "R")];
  const tabs = model();
  try {
    tabs.update({ directory: "/p", entries: rows, inbox: inbox() });
    tabs.preview("C");
    assertEquals(tabs.belongsToTab("R", "Q"), true);
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R", "C"]);
    tabs.select({ kind: "session", id: "R" });
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["R"]);
  } finally {
    tabs.stop();
  }
});
