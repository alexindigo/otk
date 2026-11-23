// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTabs } from "./supervision-fixture.ts";
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";

const entry = (id: string, parentID?: string): IndexEntry => ({
  id,
  parentID,
  title: id,
  directory: "/p",
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
});
const task = (id: string, sessions: string[]): TaskRecord => ({
  id,
  sessions,
  name: id,
  directory: "/p",
  order: 0,
});
function fixture(tasks: TaskRecord[] = []) {
  const entries = [
    entry("root"),
    entry("helper", "root"),
    entry("nested", "helper"),
    entry("other"),
  ];
  const inbox: InboxSnapshot = {
    tasks,
    projects: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    supervision: { helper: { state: "working", terminal: 0 } },
  };
  const promoted: string[] = [];
  const tabs = createTabs((session) => {
    promoted.push(session.id);
    return Promise.resolve(task("saved", [session.id]));
  });
  const input = { directory: "/p", entries, inbox };
  tabs.update(input);
  return { tabs, entries, inbox, input, promoted };
}

Deno.test("2.67 activity retains the human task group, never a helper tab", () => {
  const { tabs } = fixture();
  try {
    assertEquals(tabs.tabs().map((tab) => [tab.id, tab.status]), [[
      "root",
      "working",
    ]]);
    assertEquals(tabs.belongsToTab("root", "helper"), true);
    assertEquals(tabs.belongsToTab("root", "nested"), true);
  } finally {
    tabs.stop();
  }
});

for (
  const path of [
    "sticky restore",
    "crumb navigation",
    "attention jump",
    "URL restore",
  ]
) {
  Deno.test(`2.67 ${path} keeps exact helper view inside its human task`, () => {
    const { tabs, input } = fixture();
    try {
      if (path === "crumb navigation") tabs.preview("root");
      // All accepted routes feed the shared preview/reconciliation boundary.
      tabs.preview("helper");
      tabs.update(input);
      assertEquals(tabs.state.selected, { kind: "session", id: "root" });
      assertEquals(tabs.state.sessionID, "helper");
      assertEquals(tabs.tabs().map((tab) => tab.id), ["root"]);
      assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["root", "helper"]);
    } finally {
      tabs.stop();
    }
  });
}

for (const action of ["pin", "send", "rename"] as const) {
  Deno.test(`2.67 ${action} cannot persist an independent helper task`, async () => {
    const { tabs, promoted } = fixture();
    try {
      tabs.preview("helper");
      if (action === "pin") await tabs.pin("helper");
      else if (action === "send") {
        await tabs.send("helper", () => Promise.resolve(1));
      } else {await tabs.rename("helper", "Renamed helper", () =>
          Promise.resolve(1));}
      assertEquals(promoted, action === "rename" ? [] : ["root"]);
      assertEquals(tabs.state.sessionID, "helper");
    } finally {
      tabs.stop();
    }
  });
}

Deno.test("2.67 legacy helper task metadata cannot split a human group", () => {
  const { tabs, inbox, input } = fixture([
    task("root-task", ["root"]),
    task("helper-task", ["helper"]),
  ]);
  try {
    tabs.preview("helper");
    assertEquals(tabs.tabs().map((tab) => tab.id), ["root-task"]);
    assertEquals(tabs.taskFor("helper")?.id, "root-task");
    assertEquals(tabs.state.sessionID, "helper");
    assertEquals(tabs.crumbs().map((crumb) => crumb.id), ["root", "helper"]);
    // A missing sibling's metadata is not evidence of a human task root.
    inbox.tasks[1].sessions.push("pending-metadata");
    tabs.update(input);
    assertEquals(tabs.tabs().map((tab) => tab.id), ["root-task"]);
  } finally {
    tabs.stop();
  }
});

Deno.test("2.67 unresolved helpers cannot establish task identity before ancestry arrives", () => {
  const { tabs, input, entries } = fixture();
  try {
    tabs.update({ ...input, entries: entries.slice(1) });
    tabs.preview("helper");
    assertEquals(tabs.tabs().some((tab) => tab.id === "helper"), false);
    tabs.update(input);
    assertEquals(tabs.state.selected, { kind: "session", id: "root" });
    assertEquals(tabs.state.sessionID, "helper");
  } finally {
    tabs.stop();
  }
});
