// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { createTabs } from "./supervision-fixture.ts";
import { createSessionTree, sessionTree } from "../session-tree.ts";
import type {
  InboxSnapshot,
  IndexMetadata,
  ProjectStatus,
} from "@otk/protocol";

function fixture() {
  const tabs = createTabs(() => Promise.reject(Error("read only")));
  const entries: IndexMetadata[] = ["a", "b"].map((id, i) => ({
    id,
    title: id,
    directory: "/p",
    projectID: "p",
    timeCreated: i + 1,
    timeUpdated: 2 - i,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  }));
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: entries.map((e, i) => ({
      id: e.id,
      name: e.id,
      directory: "/p",
      sessions: [e.id],
      order: i,
    })),
    seen: {},
    finishes: {},
    pathTemplates: [],
    supervision: {},
  };
  const ids = () => tabs.tabs().map((t) => t.id);
  const update = () => {
    tabs.update({ directory: "/p", entries, inbox });
    return ids();
  };
  const set = (
    id: string,
    status: Exclude<ProjectStatus, "dependencies">,
    time: number,
  ) => {
    inbox.supervision![id] = {
      state: status === "blocked"
        ? "needsYou"
        : status === "finished"
        ? "finishedUnseen"
        : status,
      terminal: 0,
    };
    entries.find((e) => e.id === id)!.timeUpdated = time;
    return update();
  };
  update();
  return { tabs, entries, inbox, ids, update, set };
}

Deno.test("state changes and recency ticks never reorder strip or right-bar groups, even after release", () => {
  const f = fixture();
  const check = () => {
    assertEquals(f.ids(), ["a", "b"]);
    assertEquals(f.tabs.tasks().map((t) => t.id), ["a", "b"]);
    assertEquals(
      sessionTree(f.entries, f.inbox.tasks, "/p", "", ["/p"], f.ids()).filter(
        (g) => g.id,
      ).map((g) => g.id),
      ["a", "b"],
    );
  };
  try {
    for (const status of ["working", "blocked", "finished", "none"] as const) {
      for (let tick = 0; tick < 20; tick++) {
        f.set("b", status, 10000 + tick * 10000);
        check();
      }
      const release = f.tabs.holdOrder();
      f.set("a", status, 1);
      check();
      release();
      check();
    }
  } finally {
    f.tabs.stop();
  }
});

Deno.test("explicit saved task moves reorder both borrowers, arrivals append and removals preserve survivors", () => {
  const f = fixture();
  try {
    f.inbox.tasks[0].order = 1;
    f.inbox.tasks[1].order = 0;
    f.update();
    assertEquals(f.ids(), ["b", "a"]);
    assertEquals(f.tabs.tasks().map((t) => t.id), ["b", "a"]);
    f.inbox.tasks.push({
      id: "c",
      name: "c",
      directory: "/p",
      sessions: [],
      order: 2,
    });
    f.update();
    assertEquals(f.ids(), ["b", "a", "c"]);
    f.inbox.tasks = f.inbox.tasks.filter((t) => t.id !== "a");
    f.update();
    assertEquals(f.ids(), ["b", "c"]);
  } finally {
    f.tabs.stop();
  }
});

Deno.test("phantom tabs seed immutable creation order, never newest activity", () => {
  const f = fixture();
  try {
    f.tabs.stop();
    const tabs = createTabs(() => Promise.reject(Error("read only")));
    f.inbox.tasks = [];
    f.inbox.supervision = {
      a: { state: "working", terminal: 0 },
      b: { state: "needsYou", terminal: 0 },
    };
    tabs.update({
      directory: "/p",
      entries: f.entries.toReversed(),
      inbox: f.inbox,
    });
    assertEquals(tabs.tabs().map((t) => t.id), ["a", "b"]);
    f.entries[1].timeUpdated = 999999;
    tabs.update({ directory: "/p", entries: f.entries, inbox: f.inbox });
    assertEquals(tabs.tabs().map((t) => t.id), ["a", "b"]);
    tabs.stop();
  } finally {
    f.tabs.stop();
  }
});

Deno.test("native page refreshes keep sibling creation order while explicit membership keeps its saved order", () => {
  const f = fixture(), tree = createSessionTree();
  try {
    const rows = () =>
      tree.rows(f.entries, [], "/p").filter((row) => row.kind === "session")
        .map((row) => row.id);
    assertEquals(rows(), ["a", "b"]);
    f.entries.reverse();
    f.entries[0].timeUpdated = 99999;
    assertEquals(rows(), ["a", "b"]);
    f.inbox.tasks = [{
      id: "task",
      directory: "/p",
      name: "task",
      sessions: ["b", "a"],
      order: 0,
    }];
    assertEquals(
      tree.rows(f.entries, f.inbox.tasks, "/p").filter((row) =>
        row.kind === "session"
      ).map((row) => row.id),
      ["b", "a"],
    );
  } finally {
    f.tabs.stop();
  }
});

Deno.test("a held presentation cannot restore removed task authority", () => {
  const f = fixture();
  try {
    const release = f.tabs.holdOrder();
    f.inbox.tasks = f.inbox.tasks.filter((t) => t.id !== "b");
    f.update();
    assertEquals(f.ids().includes("b"), true);
    assertThrows(
      () => f.tabs.select({ kind: "task", id: "b" }),
      Error,
      "Unknown tab",
    );
    release();
    assertEquals(f.ids().includes("b"), false);
  } finally {
    f.tabs.stop();
  }
});
