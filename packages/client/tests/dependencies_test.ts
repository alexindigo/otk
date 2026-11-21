// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotStrictEquals } from "@std/assert";
import type { InboxSnapshot, IndexMetadata } from "@otk/protocol";
import {
  aggregateStatus,
  createTabs,
  dependencyCount,
  inboxProjects,
  inboxStatus,
  rollup,
} from "../mod.ts";
import { createProjectProjection } from "../project-projection.ts";

const entry = (id = "tstv1-owner"): IndexMetadata => ({
  id,
  directory: "/p",
  projectID: "repo",
  title: id,
  archived: false,
  status: "idle",
  timeCreated: 1,
  timeUpdated: 2,
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
function snapshot(): InboxSnapshot {
  return {
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    supervision: {
      "tstv1-owner": {
        state: "none",
        terminal: 0,
        dependencies: { running: 2 },
      },
      "tstv1-other": {
        state: "none",
        terminal: 0,
        dependencies: { running: 1 },
      },
    },
  };
}
Deno.test("dependencies affect aggregate priority but never own-session lamps or finish marks", () => {
  const a = entry(), inbox = snapshot();
  assertEquals(inboxStatus(a, inbox), "none");
  assertEquals(aggregateStatus(a, inbox), "dependencies");
  assertEquals(dependencyCount(a, inbox), 2);
  assertEquals(rollup([a], inbox), "dependencies");
  for (
    const [state, expected] of [["working", "working"], [
      "finishedUnseen",
      "finished",
    ], ["needsYou", "blocked"]] as const
  ) {
    inbox.supervision![a.id].state = state;
    assertEquals(rollup([a], inbox), expected);
  }
  assertEquals(
    rollup([{ ...a, deleted: { at: 3, how: "provider" } }], inbox),
    "none",
  );
  assertEquals(inbox.finishes, {});
});
Deno.test("task ownership counts only its own sessions; dependency-only phantoms retire at zero", () => {
  const inbox = snapshot(), entries = [entry(), entry("tstv1-other")];
  inbox.tasks = [{
    id: "task",
    directory: "/p",
    name: "Task",
    order: 0,
    sessions: [entries[0].id],
  }];
  const tabs = createTabs(() => Promise.resolve(inbox.tasks[0]));
  tabs.update({ directory: "/p", entries, inbox });
  assertEquals(
    tabs.tabs().map((tab) => [tab.id, tab.status, tab.dependencies]),
    [
      ["tstv1-other", "dependencies", 1],
      ["task", "dependencies", 2],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  inbox.supervision!["tstv1-other"] = { state: "none", terminal: 0 };
  tabs.update({ directory: "/p", entries, inbox });
  assertEquals(tabs.tabs().map((tab) => tab.id), ["task"]);
  tabs.stop();
});
Deno.test("count-only supervision changes invalidate keyed tab and project inputs without a metadata update", () => {
  let inbox = snapshot();
  const a = { ...entry(), sidecarId: "local" };
  const projection = createProjectProjection({
    entry: (id) => id === a.id ? a : undefined,
    inbox: () => inbox,
  });
  projection.update([a.id]);
  projection.inbox(inbox);
  const before = projection.input("/p");
  assertEquals(projection.row("/p", 0)?.dependencies, 2);
  inbox = {
    ...inbox,
    supervision: {
      [a.id]: { state: "none", terminal: 0, dependencies: { running: 3 } },
    },
  };
  projection.inbox(inbox, {
    baseline: false,
    projects: [],
    sessions: [a.id],
    tasks: false,
    discovery: false,
  });
  assertNotStrictEquals(projection.input("/p"), before);
  assertEquals(projection.row("/p", 0)?.dependencies, 3);
  assertEquals(projection.row("/p", 0)?.status, "dependencies");
  assertEquals(inboxStatus(a, inbox), "none");
});
Deno.test("orphan-only project summaries lift Inactive without fabricating population, then return to policy", () => {
  const inbox = snapshot();
  inbox.projects = [{
    directory: "/orphan",
    order: 0,
    added: true,
    inactive: true,
    lastVisit: 1,
  }];
  inbox.summaries = {
    "/orphan": {
      directory: "/orphan",
      hasSessions: false,
      sessionCount: 0,
      unseenCount: 0,
      lastActivity: null,
      authority: "stale",
      status: "dependencies",
      dependencies: 1,
    },
  };
  const row = inboxProjects([], inbox, 10)[0];
  assertEquals([row.status, row.group, row.inactive, row.dependencies], [
    "dependencies",
    "active",
    false,
    1,
  ]);
  inbox.summaries["/orphan"] = {
    ...inbox.summaries["/orphan"],
    status: "none",
    dependencies: 0,
  };
  const stopped = inboxProjects([], inbox, 10)[0];
  assertEquals([stopped.status, stopped.group, stopped.inactive], [
    "none",
    "inactive",
    true,
  ]);
});
