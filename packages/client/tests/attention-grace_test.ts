// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createAttentionGrace } from "../attention-grace.ts";
import { createTabs } from "../tabs.ts";
import type { IndexMetadata } from "@otk/protocol";
function clock() {
  let now = 0, sequence = 0;
  const timers = new Map<number, { due: number; callback(): void }>();
  return {
    now: () => now,
    set(callback: () => void, ms: number) {
      const id = ++sequence;
      timers.set(id, { due: now + ms, callback });
      return id;
    },
    clear(id: unknown) {
      timers.delete(id as number);
    },
    get pendingTimers() {
      return timers.size;
    },
    tick(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

Deno.test("one request deadline serves composer and every reduced-motion lamp", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const scope = (id: string) => id === "child";
  owner.light("project", "working", "a", scope, true);
  owner.light("child", "working", "a", scope, true);
  owner.observe("a", "child", { permissions: { keys: ["p"], fresh: true } });
  assertEquals(owner.permission("a", "child", "p"), false);
  assertEquals(owner.light("project", "blocked", "a", scope, false), "blocked");
  time.tick(499);
  assertEquals(owner.permission("a", "child", "p"), false);
  assertEquals(owner.light("child", "blocked", "a", scope, true), "working");
  // A late-mounted surface borrows the original deadline, not another timer.
  assertEquals(owner.light("late", "blocked", "a", scope, true), "none");
  time.tick(1);
  assertEquals(owner.permission("a", "child", "p"), true);
  for (const key of ["project", "child", "late"]) {
    assertEquals(owner.light(key, "blocked", "a", scope, true), "blocked");
  }
  owner.stop();
});

Deno.test("settlement cancels grace; replacement and sidecars have independent identities", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const scope = () => true;
  owner.light("row", "working", "a", scope, true);
  assertEquals(owner.permission("a", "s", "p"), false);
  time.tick(200);
  owner.settled("a", "p");
  assertEquals(owner.light("row", "working", "a", scope, true), "working");
  assertEquals(owner.permission("b", "s", "p"), false);
  assertEquals(owner.permission("a", "s", "next"), false);
  time.tick(300);
  assertEquals(owner.permission("a", "s", "next"), false);
  assertEquals(owner.light("row", "blocked", "a", scope, true), "working");
  assertEquals(
    owner.light("row", "blocked", "a", scope, true, true),
    "blocked",
  );
  time.tick(200);
  assertEquals(owner.permission("a", "s", "next"), true);
  assertEquals(owner.permission("b", "s", "p"), true);
  owner.removeServer("a");
  owner.stop();
});

Deno.test("duplicates cannot postpone grace and questions bypass permission grace", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const scope = () => true;
  owner.light("row", "working", "a", scope, true);
  owner.observe("a", "s", { permissions: { keys: ["p"], fresh: true } });
  time.tick(400);
  owner.observe("a", "s", { permissions: { keys: ["p"], fresh: true } });
  assertEquals(owner.light("row", "blocked", "a", scope, true), "working");
  owner.observe("a", "q", { inputs: { keys: ["question"], fresh: true } });
  assertEquals(owner.light("row", "blocked", "a", scope, true), "blocked");
  time.tick(100);
  assertEquals(owner.permission("a", "s", "p"), true);
  owner.stop();
});

Deno.test("grace owns one scheduler and stop fences late publication", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  let publications = 0;
  owner.subscribe(() => publications++);
  owner.permission("a", "s", "one");
  owner.permission("a", "s", "two");
  assertEquals(time.pendingTimers, 1);
  owner.settled("a", "one");
  time.tick(500);
  const final = publications;
  owner.stop();
  time.tick(500);
  assertEquals(publications, final);
  assertEquals(time.pendingTimers, 0);
});

Deno.test("motion changes and incomplete metadata do not restart a request deadline", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const scope = () => true;
  owner.light("row", "working", "a", scope, false);
  owner.permission("a", "s", "p");
  time.tick(300);
  owner.observe("a", "s");
  assertEquals(owner.light("row", "blocked", "a", scope, false), "blocked");
  assertEquals(owner.light("row", "blocked", "a", scope, true), "working");
  time.tick(200);
  assertEquals(owner.permission("a", "s", "p"), true);
  assertEquals(owner.light("row", "blocked", "a", scope, true), "blocked");
  owner.stop();
});

Deno.test("stale empty inventories cannot retire a still-pending request deadline", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  owner.permission("a", "s", "p");
  time.tick(200);
  owner.observe("a", "s", { permissions: { keys: [], fresh: false } });
  assertEquals(owner.permission("a", "s", "p"), false);
  time.tick(300);
  assertEquals(owner.permission("a", "s", "p"), true);
  owner.stop();
});

Deno.test("fresh absence retires lamp grace without restarting a presented request", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const scope = () => true;
  owner.light("row", "working", "a", scope, true);
  assertEquals(owner.permission("a", "s", "p"), false);
  time.tick(500);
  assertEquals(owner.permission("a", "s", "p"), true);
  // Native inventory can report the reply before the content removal arrives.
  owner.observe("a", "s", { permissions: { keys: [], fresh: true } });
  assertEquals(owner.permission("a", "s", "p"), true);
  assertEquals(owner.permission("a", "s", "p"), true);
  assertEquals(time.pendingTimers, 0);

  assertEquals(owner.permission("a", "s", "q"), false);
  time.tick(200);
  owner.observe("a", "s", { permissions: { keys: [], fresh: true } });
  // An absent request no longer holds the lamp, nor restarts its own deadline.
  assertEquals(owner.light("row", "blocked", "a", scope, true), "blocked");
  assertEquals(owner.permission("a", "s", "q"), false);
  time.tick(300);
  assertEquals(owner.permission("a", "s", "q"), true);
  owner.settled("a", "p");
  owner.settled("a", "q");
  assertEquals(time.pendingTimers, 0);
  owner.stop();
});

Deno.test("lamp grace borrows tab ownership, excluding children assigned to another task", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const tabs = createTabs(() => {
    throw new Error("No promotion");
  });
  const entry = (id: string, parentID?: string): IndexMetadata => ({
    id,
    parentID,
    title: id,
    directory: "/p",
    projectID: "p",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "busy",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  const input = {
    directory: "/p",
    entries: [
      entry("parent"),
      entry("split", "parent"),
      entry("own-child", "parent"),
      entry("orphan", "missing-parent"),
      entry("orphan-helper", "orphan"),
    ],
    inbox: {
      projects: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
      supervision: { orphan: { state: "working" as const, terminal: 0 } },
      tasks: [
        {
          id: "task",
          directory: "/p",
          name: "Parent task",
          order: 0,
          sessions: ["parent"],
        },
        {
          id: "other",
          directory: "/p",
          name: "Split child task",
          order: 1,
          sessions: ["split"],
        },
      ],
    },
  };
  tabs.update(input);
  assertEquals(tabs.tabs().some((tab) => tab.id === "orphan"), true);
  const contains = (id: string) => tabs.belongsToTab("task", id);
  assertEquals(contains("parent"), true);
  assertEquals(contains("own-child"), true);
  assertEquals(contains("split"), false);
  owner.permission("a", "split", "older");
  time.tick(500);
  owner.light("tab", "working", "a", contains, true);
  owner.permission("a", "parent", "new");
  assertEquals(owner.light("tab", "blocked", "a", contains, true), "working");
  time.tick(500);
  assertEquals(owner.light("tab", "blocked", "a", contains, true), "blocked");
  tabs.update({
    ...input,
    inbox: { ...input.inbox, tasks: input.inbox.tasks.slice(1) },
  });
  // SH1 gives an ungrouped child its own phantom and its own supervision lamp.
  assertEquals(tabs.belongsToTab("parent", "own-child"), false);
  assertEquals(tabs.belongsToTab("own-child", "own-child"), true);
  assertEquals(tabs.belongsToTab("parent", "split"), false);
  assertEquals(tabs.belongsToTab("parent", "outside"), false);
  assertEquals(tabs.belongsToTab("orphan", "orphan"), true);
  assertEquals(tabs.belongsToTab("orphan", "orphan-helper"), false);
  owner.stop();
  tabs.stop();
});

Deno.test("automatic permissions cannot release manual lamp grace; questions remain immediate", () => {
  const time = clock();
  const owner = createAttentionGrace({ clock: time });
  const contains = () => true, waiting = (id: string) => id !== "automatic";
  owner.permission("a", "automatic", "old");
  time.tick(500);
  owner.light("project", "working", "a", contains, true, false, waiting);
  owner.permission("a", "manual", "new");
  assertEquals(
    owner.light("project", "blocked", "a", contains, true, false, waiting),
    "working",
  );
  owner.observe("a", "automatic", {
    permissions: { keys: ["old"], fresh: true },
    inputs: { keys: ["question"], fresh: true },
  });
  assertEquals(
    owner.light("project", "blocked", "a", contains, true, false, waiting),
    "blocked",
  );
  owner.observe("a", "automatic", {
    permissions: { keys: ["old"], fresh: true },
    inputs: { keys: [], fresh: true },
  });
  time.tick(499);
  assertEquals(
    owner.light("project", "blocked", "a", contains, true, false, waiting),
    "working",
  );
  time.tick(1);
  assertEquals(
    owner.light("project", "blocked", "a", contains, true, false, waiting),
    "blocked",
  );
  owner.stop();
});
