// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  ageing,
  createInbox,
  createTabs,
  inboxProjects,
  inboxStatus,
  rollup,
  unread,
  visitTime,
} from "@otk/client";
import { DEFAULT_PREFS, isPreference } from "@otk/protocol";
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";
function entry(id: string, status: IndexEntry["status"] = "idle"): IndexEntry {
  return {
    id,
    directory: "/p",
    projectID: "p",
    title: id,
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
function snapshot(): InboxSnapshot {
  return {
    projects: [{
      directory: "/p",
      order: 0,
      added: true,
      inactive: false,
      lastVisit: 0,
    }],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
}
Deno.test("inbox roll-up gives blocked, unseen-finished, working then idle priority without treating idle startup as a finish", () => {
  const inbox = snapshot(),
    idle = entry("idle"),
    busy = entry("busy", "busy"),
    done = entry("done"),
    blocked = entry("blocked");
  inbox.finishes.done = 10;
  blocked.attention.childQuestions = 1;
  assertEquals(rollup([idle], inbox), "idle");
  assertEquals(rollup([idle, done], inbox), "finished");
  assertEquals(rollup([done, busy], inbox), "finished");
  assertEquals(rollup([blocked, done, busy], inbox), "blocked");
  assertEquals(inboxStatus(entry("retry", "retry"), inbox), "working");
  blocked.attention.childQuestions = 0;
  blocked.attention.error = "failed";
  assertEquals(inboxStatus(blocked, inbox), "blocked");
  assertEquals(rollup([], inbox), "idle");
});
Deno.test("tracked and discovered projects and task tabs share attention-first aggregation independently of input order", () => {
  const inbox = snapshot(),
    done = entry("done"),
    busy = entry("busy", "busy"),
    blocked = entry("blocked");
  inbox.finishes.done = 10;
  inbox.tasks.push({
    id: "task",
    directory: "/p",
    name: "Review",
    order: 0,
    sessions: ["done", "busy", "blocked"],
  });
  const tabs = createTabs(() => {
    throw new Error("unused");
  });
  for (const needsInput of [false, true]) {
    blocked.attention.permissions = needsInput ? 1 : 0;
    const expected = needsInput ? "blocked" : "finished";
    for (const entries of [[done, busy, blocked], [blocked, busy, done]]) {
      for (const projects of [inbox.projects, []]) {
        assertEquals(
          inboxProjects(entries, { ...inbox, projects }, 0)[0].status,
          expected,
        );
      }
      tabs.update({ directory: "/p", entries, inbox });
      assertEquals(tabs.tabs()[0].status, expected);
    }
  }
  inbox.seen.done = 10;
  blocked.attention.permissions = 0;
  tabs.update({ directory: "/p", entries: [done, busy, blocked], inbox });
  assertEquals(tabs.tabs()[0].status, "working");
  tabs.stop();
});
Deno.test("unread is strictly finish greater than seen, independently of working status", () => {
  const inbox = snapshot();
  assertEquals(unread("s", inbox), false);
  inbox.finishes.s = 10;
  assert(unread("s", inbox));
  inbox.seen.s = 10;
  assertEquals(unread("s", inbox), false);
  inbox.finishes.s = 11;
  assert(unread("s", inbox));
  assertEquals(inboxStatus(entry("s", "busy"), inbox), "working");
});
Deno.test("visit labels and ageing use the injected clock at exact 2h, 8h, 24h boundaries and configured thresholds", () => {
  const h = 3_600_000, last = 1000;
  for (
    const [elapsed, text] of [
      [0, "now"],
      [59_999, "now"],
      [12 * 60_000, "12m"],
      [2 * h, "2h"],
      [27 * h, "1d 3h"],
      [48 * h, "2d"],
    ] as const
  ) assertEquals(visitTime(last, last + elapsed), text);
  for (
    const [elapsed, level] of [
      [2 * h - 1, 0],
      [2 * h, 1],
      [8 * h - 1, 1],
      [8 * h, 2],
      [24 * h - 1, 2],
      [24 * h, 3],
    ]
  ) assertEquals(ageing(last, last + elapsed), level);
  assertEquals(ageing(last, last + 30, [10, 20, 30]), 3);
  assertEquals(visitTime(last, 0), "now");
  assertEquals(DEFAULT_PREFS.projectAgeing, [2 * h, 8 * h, 24 * h]);
  assert(isPreference("projectAgeing", [10, 20, 30]));
  for (
    const invalid of [[10, 5, 30], [10, 10, 30], [0, 20, 30], [10, 20], [
      10,
      20,
      Infinity,
    ]]
  ) assertEquals(isPreference("projectAgeing", invalid), false);
});
Deno.test("project projections keep stored order, freeze inactive visits and expose every activity including new unread completion", () => {
  const inbox = snapshot();
  inbox.projects[0] = {
    ...inbox.projects[0],
    inactive: true,
    inactiveAt: 60_000,
  };
  inbox.projects.unshift({
    directory: "/q",
    order: 1,
    added: false,
    inactive: false,
    lastVisit: 0,
  });
  const idle = entry("s");
  assertEquals(inboxProjects([idle], inbox, 120_000).map((p) => p.directory), [
    "/p",
    "/q",
  ]);
  assertEquals(inboxProjects([idle], inbox, 120_000)[0].visitText, "1m");
  for (
    const active of [entry("s", "busy"), {
      ...entry("s"),
      attention: { ...idle.attention, permissions: 1 },
    }]
  ) assertEquals(inboxProjects([active], inbox, 120_000)[0].inactive, false);
  inbox.finishes.s = 10;
  assertEquals(inboxProjects([idle], inbox, 120_000)[0].inactive, false);
  assertEquals(inboxProjects([idle], inbox, 120_000)[0].unread, true);
  inbox.seen.s = 10;
  assertEquals(inboxProjects([idle], inbox, 120_000)[0].inactive, true);
});
Deno.test("opening a project or session and all action wrappers reset the same server visit clock", async () => {
  let now = 1, visit = 0, seen = 0;
  const calls: string[] = [];
  const model = createInbox({
    call(method, _params) {
      calls.push(method);
      if (method === "projects.visit") visit = now;
      if (method === "sessions.seen") seen = now;
      return Promise.resolve(undefined) as never;
    },
  });
  await model.openProject("/p");
  assertEquals(visit, 1);
  now = 2;
  await model.openSession("s", "/p");
  assertEquals([visit, seen], [2, 2]);
  for (const action of ["send", "approve", "answer", "interrupt"]) {
    now++;
    assertEquals(await model.act("/p", () => Promise.resolve(action)), action);
    assertEquals(visit, now);
  }
  assertEquals(calls.filter((c) => c === "projects.visit").length, 6);
});
Deno.test("phantom rule 1: all ungrouped working, blocked and unseen-finished sessions survive a model reload", () => {
  const inbox = snapshot(), blocked = entry("blocked");
  blocked.attention.questions = 1;
  inbox.finishes.finished = 10;
  const entries = [
    entry("busy", "busy"),
    blocked,
    entry("finished"),
    entry("idle"),
    entry("grouped", "busy"),
  ];
  inbox.tasks.push({
    id: "task",
    directory: "/p",
    name: "exec",
    order: 0,
    sessions: ["grouped"],
  });
  for (let reload = 0; reload < 2; reload++) {
    const tabs = createTabs(() => {
      throw new Error("unused");
    });
    tabs.update({ directory: "/p", entries, inbox });
    assertEquals(tabs.tabs().map((t) => t.id), [
      "task",
      "busy",
      "blocked",
      "finished",
    ]);
  }
});
Deno.test("phantom rule 2: a single preview replaces idle previews but cannot replace mandatory activity tabs or duplicate task sessions", () => {
  const inbox = snapshot(),
    tabs = createTabs(() => {
      throw new Error("unused");
    });
  inbox.tasks.push({
    id: "task",
    directory: "/p",
    name: "exec",
    order: 0,
    sessions: ["grouped"],
  });
  tabs.update({
    directory: "/p",
    entries: [entry("a"), entry("b"), entry("busy", "busy"), entry("grouped")],
    inbox,
  });
  tabs.preview("a");
  tabs.preview("b");
  assertEquals(tabs.tabs().map((t) => t.id), ["task", "b", "busy"]);
  tabs.preview("busy");
  tabs.preview("a");
  assertEquals(tabs.tabs().filter((t) => t.preview).map((t) => t.id), ["a"]);
  assert(tabs.tabs().some((t) => t.id === "busy"));
  tabs.preview("grouped");
  assertEquals(tabs.state.selected, { kind: "task", id: "task" });
  assertEquals(tabs.tabs().map((t) => t.id), ["task", "busy"]);
});
Deno.test("phantom rule 3: pin, double-click and sending promote to a title-named task through an injected port", async () => {
  for (const action of ["pin", "double-click", "send"]) {
    const inbox = snapshot(), s = entry("session title");
    let promoted = 0, sent = 0;
    const tabs = createTabs((session) => {
      const task: TaskRecord = {
        id: "solid",
        directory: session.directory,
        name: session.title,
        order: 0,
        sessions: [session.id],
      };
      inbox.tasks.push(task);
      promoted++;
      return Promise.resolve(task);
    });
    const input = { directory: "/p", entries: [s], inbox };
    tabs.update(input);
    tabs.preview(s.id);
    if (action === "send") {
      await tabs.send(s.id, () => {
        sent++;
        return Promise.resolve();
      });
    } else await tabs.pin(s.id);
    tabs.update(input);
    assertEquals(tabs.tabs().map((t) => [t.kind, t.title, t.sessions]), [[
      "task",
      s.title,
      [s.id],
    ]]);
    assertEquals(tabs.state.selected, { kind: "task", id: "solid" });
    assertEquals(promoted, 1);
    assertEquals(sent, action === "send" ? 1 : 0);
  }
});
Deno.test("phantom rule 4: idle and seen stays selected until leaving; busy or unseen never disappears on leave", () => {
  const inbox = snapshot(),
    s = entry("s", "busy"),
    other = entry("other", "busy");
  const tabs = createTabs(() => {
    throw new Error("unused");
  });
  const input = { directory: "/p", entries: [s, other], inbox };
  tabs.update(input);
  tabs.select({ kind: "session", id: "s" });
  s.status = "idle";
  inbox.finishes.s = 10;
  tabs.update(input);
  tabs.select({ kind: "session", id: "other" });
  assert(tabs.tabs().some((t) => t.id === "s"));
  tabs.select({ kind: "session", id: "s" });
  inbox.seen.s = 10;
  tabs.update(input);
  assert(tabs.tabs().some((t) => t.id === "s"));
  tabs.select({ kind: "session", id: "other" });
  assertEquals(tabs.tabs().some((t) => t.id === "s"), false);
  assertEquals(input.entries.length, 2);
});

Deno.test("concurrent phantom promotions share one operation and a late result cannot steal a newer selection", async () => {
  const inbox = snapshot();
  let resolve!: (task: TaskRecord) => void, calls = 0;
  const tabs = createTabs(() => {
    calls++;
    return new Promise<TaskRecord>((done) => resolve = done);
  });
  tabs.update({
    directory: "/p",
    entries: [entry("a", "busy"), entry("b", "busy")],
    inbox,
  });
  tabs.preview("a");
  const first = tabs.pin("a"), second = tabs.pin("a");
  await Promise.resolve();
  tabs.preview("b");
  resolve({ id: "new", directory: "/p", name: "a", order: 0, sessions: ["a"] });
  await Promise.all([first, second]);
  assertEquals(calls, 1);
  assertEquals(tabs.state.selected, { kind: "session", id: "b" });
});

Deno.test("task selection remembers its session and publishes input invalidation for reactive consumers", () => {
  const inbox = snapshot(),
    tabs = createTabs(() => {
      throw new Error("unused");
    });
  inbox.tasks.push({
    id: "task",
    directory: "/p",
    name: "exec",
    order: 0,
    sessions: ["a", "b"],
  });
  const input = {
    directory: "/p",
    entries: [entry("a"), entry("b"), entry("busy", "busy")],
    inbox,
  };
  tabs.update(input);
  const revision = tabs.state.revision;
  tabs.select({ kind: "task", id: "task" }, "b");
  tabs.preview("busy");
  tabs.select({ kind: "task", id: "task" });
  assertEquals(tabs.state.sessionID, "b");
  input.entries[2].status = "idle";
  tabs.update(input);
  assert(tabs.state.revision > revision);
  assertEquals(tabs.tabs().map((t) => t.id), ["task"]);
});

Deno.test("helper URLs select their owning task and removed membership preserves the viewed session as a phantom", () => {
  const inbox = snapshot(),
    tabs = createTabs(() => {
      throw new Error("unused");
    });
  const task = {
    id: "task",
    directory: "/p",
    name: "exec",
    order: 0,
    sessions: ["a"],
  };
  inbox.tasks.push(task);
  const input = {
    directory: "/p",
    entries: [entry("a"), { ...entry("helper"), parentID: "a" }],
    inbox,
  };
  tabs.update(input);
  tabs.preview("helper");
  assertEquals(tabs.state.selected, { kind: "task", id: "task" });
  assertEquals(tabs.sessionFor("task"), "helper");
  task.sessions = [];
  tabs.update(input);
  assertEquals(tabs.state.selected, { kind: "session", id: "helper" });
  assertEquals(tabs.state.sessionID, "helper");
  task.sessions = ["a"];
  inbox.tasks.push({
    id: "helper-task",
    directory: "/p",
    name: "Helper",
    order: 1,
    sessions: ["helper"],
  });
  tabs.update(input);
  tabs.preview("helper");
  assertEquals(tabs.state.selected, { kind: "task", id: "helper-task" });
});
