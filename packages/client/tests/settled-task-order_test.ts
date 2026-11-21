// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { createTabs } from "../tabs.ts";
import { sessionTree } from "../session-tree.ts";
import type {
  InboxSnapshot,
  IndexMetadata,
  ProjectStatus,
} from "@otk/protocol";

function clock() {
  let now = 0, id = 0;
  const timers = new Map<number, { due: number; callback(): void }>();
  return {
    now: () => now,
    set(callback: () => void, ms: number) {
      timers.set(++id, { due: now + ms, callback });
      return id;
    },
    clear(id: unknown) {
      timers.delete(id as number);
    },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) =>
          t.due <= end
        ).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) {
          break;
        }
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
function fixture() {
  const time = clock();
  const tabs = createTabs(
    () => Promise.reject(Error("read only")),
    undefined,
    undefined,
    { clock: time },
  );
  const entries: IndexMetadata[] = ["a", "b"].map((id, i) => ({
    id,
    title: id,
    directory: "/p",
    projectID: "p",
    timeCreated: 1,
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
  const set = (id: string, status: ProjectStatus, activity?: number) => {
    inbox.supervision![id] = {
      state: status === "blocked"
        ? "needsYou"
        : status === "finished"
        ? "finishedUnseen"
        : status,
      terminal: 0,
    };
    const entry = entries.find((e) => e.id === id)!;
    if (activity !== undefined) entry.timeUpdated = activity;
    tabs.update({ directory: "/p", entries, inbox });
    return tabs.tabs().map((t) => t.id);
  };
  set("a", "working");
  set("b", "working");
  time.tick(5000);
  tabs.tabs();
  return {
    time,
    tabs,
    entries,
    inbox,
    set,
    ids: () => tabs.tabs().map((t) => t.id),
  };
}
Deno.test("rapid rank and recency flips never reorder task lists", () => {
  const f = fixture();
  try {
    assertEquals(f.ids(), ["a", "b"]);
    f.set("b", "finished", 10);
    f.time.tick(1000);
    assertEquals(f.ids(), ["a", "b"]);
    f.set("b", "working", 20);
    f.time.tick(1000);
    assertEquals(f.ids(), ["a", "b"]);
    f.set("a", "none");
    f.time.tick(1000);
    f.set("a", "working");
    assertEquals(f.ids(), ["a", "b"]);
  } finally {
    f.tabs.stop();
  }
});
Deno.test("a settled state reorders once even while recency keeps changing", () => {
  const f = fixture();
  let changes = 0;
  let prior = f.ids().join();
  const stop = f.tabs.subscribe(() => {
    const next = f.ids().join();
    if (prior !== next) changes++;
    prior = next;
  });
  try {
    f.set("b", "finished", 10);
    for (let i = 0; i < 5; i++) {
      f.time.tick(1000);
      f.set("b", "finished", 20 + i);
    }
    assertEquals(f.ids(), ["b", "a"]);
    assertEquals(changes, 1);
    f.time.tick(10000);
    assertEquals(changes, 1);
  } finally {
    stop();
    f.tabs.stop();
  }
});
Deno.test("blocked needs-you moves promptly and recovery has hysteresis", () => {
  const f = fixture();
  try {
    f.entries[1].attention.questions = 1;
    assertEquals(f.set("b", "blocked"), ["b", "a"]);
    f.set("b", "working");
    f.time.tick(1000);
    assertEquals(f.ids(), ["b", "a"]);
    f.time.tick(4000);
    assertEquals(f.ids(), ["a", "b"]);
  } finally {
    f.tabs.stop();
  }
});
Deno.test("short permission traffic does not move tasks; held permission moves after grace", () => {
  const f = fixture();
  try {
    f.entries[1].activity = {
      permissions: { fresh: true, keys: ["permission"] },
    };
    f.entries[1].attention.permissions = 1;
    assertEquals(f.set("b", "blocked"), ["a", "b"]);
    f.time.tick(100);
    f.set("b", "working");
    f.time.tick(1000);
    assertEquals(f.ids(), ["a", "b"]);
    f.set("b", "blocked");
    f.time.tick(500);
    assertEquals(f.ids(), ["b", "a"]);
  } finally {
    f.tabs.stop();
  }
});
Deno.test("hover or interaction freezes order across every borrower until all release", () => {
  const f = fixture();
  try {
    const hover = f.tabs.holdOrder(), focus = f.tabs.holdOrder();
    f.set("b", "blocked");
    f.time.tick(10000);
    assertEquals(f.ids(), ["a", "b"]);
    assertEquals(f.tabs.tasks().map((t) => t.id), ["a", "b"]);
    hover();
    assertEquals(f.ids(), ["a", "b"]);
    focus();
    assertEquals(f.ids(), ["b", "a"]);
    assertEquals(f.tabs.tasks().map((t) => t.id), ["b", "a"]);
    assertEquals(
      sessionTree(f.entries, f.inbox.tasks, "/p", "", ["/p"], f.ids()).filter(
        (g) => g.id,
      ).map((g) => g.id),
      ["b", "a"],
    );
  } finally {
    f.tabs.stop();
  }
});
Deno.test("order timers retire with the tabs owner", () => {
  const f = fixture();
  f.set("b", "finished", 10);
  assertEquals(f.time.pending(), 1);
  f.tabs.stop();
  assertEquals(f.time.pending(), 0);
});

Deno.test("native sibling chronology cannot bypass the shared interaction hold", () => {
  const f = fixture();
  const a = { key: "a", kind: "heading" as const, group: "a", title: "a" };
  const b = { key: "b", kind: "heading" as const, group: "b", title: "b" };
  try {
    assertEquals(f.tabs.orderRows([a, b]), [a, b]);
    const release = f.tabs.holdOrder();
    assertEquals(f.tabs.orderRows([b, a]), [a, b]);
    release();
    assertEquals(f.tabs.orderRows([b, a]), [b, a]);
  } finally {
    f.tabs.stop();
  }
});

Deno.test("a held presentation cannot restore removed task authority", () => {
  const f = fixture();
  try {
    f.inbox.tasks[1].id = "task-b";
    f.set("b", "working");
    const release = f.tabs.holdOrder();
    f.inbox.tasks = f.inbox.tasks.filter((task) => task.id !== "task-b");
    f.set("b", "working");
    assertEquals(f.ids().includes("task-b"), true);
    assertThrows(
      () => f.tabs.select({ kind: "task", id: "task-b" }),
      Error,
      "Unknown tab",
    );
    release();
    assertEquals(f.ids().includes("task-b"), false);
  } finally {
    f.tabs.stop();
  }
});
