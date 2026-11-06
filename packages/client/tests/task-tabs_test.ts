// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createTabs, inboxProjects, taskBreadcrumbs } from "@otk/client";
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";

const entry = (id: string, timeUpdated = 1, parentID?: string): IndexEntry => ({
  id,
  title: id,
  parentID,
  directory: "/p",
  projectID: "p",
  timeCreated: 1,
  timeUpdated,
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
const task = (id: string, sessions = [id], order = 0): TaskRecord => ({
  id,
  sessions,
  order,
  directory: "/p",
  name: id,
});
const inbox = (tasks: TaskRecord[] = []): InboxSnapshot => ({
  tasks,
  projects: [],
  seen: {},
  finishes: {},
  pathTemplates: [],
});
const model = () =>
  createTabs(() => {
    throw Error("No promotion");
  });

Deno.test("tab projection borrows each live resource input once for the whole population", () => {
  const entries = Array.from({ length: 300 }, (_, i) => entry(`session-${i}`));
  const meta = inbox([task("task", [entries[0].id])]);
  const reads = { entries: 0, inbox: 0, taskActivity: 0 };
  const tabs = model();
  tabs.update({
    directory: "/p",
    get entries() {
      reads.entries++;
      return entries;
    },
    get inbox() {
      reads.inbox++;
      return meta;
    },
    get taskActivity() {
      reads.taskActivity++;
      return {};
    },
  });
  reads.entries = reads.inbox = reads.taskActivity = 0;
  assertEquals(tabs.tabs().map((tab) => tab.id), ["task"]);
  assertEquals(reads, { entries: 1, inbox: 1, taskActivity: 1 });
});

Deno.test("task tabs order by urgency then newest family activity, never stored order", () => {
  const entries = [
    entry("idle", 100),
    entry("working", 20),
    entry("done", 10),
    entry("blocked", 1),
    entry("newer", 200),
  ];
  entries[1].status = "busy";
  entries[3].attention.questions = 1;
  const meta = inbox(entries.map((e, i) => task(e.id, [e.id], i)));
  meta.finishes.done = 50;
  const tabs = model();
  const input = { directory: "/p", entries, inbox: meta };
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => t.id), [
    "blocked",
    "done",
    "working",
    "newer",
    "idle",
  ]);
  meta.tasks.reverse().forEach((t, i) => t.order = i);
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => t.id), [
    "blocked",
    "done",
    "working",
    "newer",
    "idle",
  ]);
  entries[4].status = "busy";
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => t.id), [
    "blocked",
    "done",
    "newer",
    "working",
    "idle",
  ]);
});

Deno.test("helpers roll up to their nearest task, never become phantom tabs, and finished helpers are quiet", () => {
  const root = entry("root"),
    other = entry("other", 20),
    child = entry("child", 50, "root"),
    nested = entry("nested", 100, "child");
  const meta = inbox([
    task("root-task", [root.id]),
    task("other-task", [other.id]),
  ]);
  const tabs = model(),
    input = {
      directory: "/p",
      entries: [root, other, child, nested],
      inbox: meta,
    };
  child.status = "busy";
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => [t.id, t.status]), [[
    "root-task",
    "working",
  ], ["other-task", "idle"]]);
  nested.attention.permissions = 1;
  tabs.update(input);
  assertEquals(tabs.tabs()[0].status, "blocked");
  child.status = "idle";
  nested.attention.permissions = 0;
  meta.finishes.child = meta.finishes.nested = 200;
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => t.status), ["idle", "idle"]);
  assertEquals(inboxProjects(input.entries, meta, 0)[0].unread, false);
  meta.tasks.push(task("child-task", ["child"]));
  nested.status = "busy";
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => [t.id, t.status]), [
    ["child-task", "working"],
    ["other-task", "idle"],
    ["root-task", "idle"],
  ]);
  assertEquals(
    taskBreadcrumbs(meta.tasks[0], input.entries, meta.tasks).map((c) => c.id),
    ["root"],
  );
});

Deno.test("no-task parent owns its active helper phantom and helper previews retain root tab identity", () => {
  const root = entry("root"),
    child = entry("child", 2, "root"),
    other = entry("other");
  const meta = inbox(),
    tabs = model(),
    input = { directory: "/p", entries: [root, child, other], inbox: meta };
  child.attention.questions = 1;
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => [t.id, t.status]), [["root", "blocked"]]);
  tabs.preview(child.id);
  assertEquals(tabs.state.selected, { kind: "session", id: "root" });
  assertEquals(tabs.state.sessionID, "child");
  child.attention.questions = 0;
  meta.finishes.child = 10;
  tabs.update(input);
  assertEquals(tabs.tabs().map((t) => [t.id, t.status]), [["root", "idle"]]);
  tabs.preview("other");
  assertEquals(tabs.tabs().map((t) => t.id), ["other"]);
  tabs.preview("child");
  tabs.close("child");
  assertEquals(tabs.tabs(), []);
});

Deno.test("phantom crumbs show all active descendants of every member and retire even while selected", () => {
  const a = entry("a"),
    b = entry("b"),
    child = entry("child", 2, "b"),
    nested = entry("nested", 3, "child");
  nested.status = "busy";
  const members = task("task", ["a", "b"]), entries = [a, b, child, nested];
  assertEquals(taskBreadcrumbs(members, entries).map((c) => [c.id, c.depth]), [
    ["a", 0],
    ["b", 0],
    ["nested", 2],
  ]);
  child.attention.questions = 1;
  assertEquals(taskBreadcrumbs(members, entries).map((c) => c.id), [
    "a",
    "b",
    "child",
    "nested",
  ]);
  child.attention.questions = 0;
  nested.status = "idle";
  assertEquals(taskBreadcrumbs(members, entries).map((c) => c.id), ["a", "b"]);
  members.sessions.push("child");
  assertEquals(taskBreadcrumbs(members, entries).map((c) => c.id), [
    "a",
    "b",
    "child",
  ]);
});

Deno.test("rename and pin share captured-name promotion without selecting a late result, and failed rename never promotes", async () => {
  const named: string[] = [], meta = inbox();
  const tabs = createTabs((session) => {
    named.push(session.title);
    return Promise.resolve(task("persisted", [session.id]));
  });
  tabs.update({
    directory: "/p",
    entries: [entry("root"), entry("other")],
    inbox: meta,
  });
  tabs.preview("root");
  const held = Promise.withResolvers<number>();
  const renaming = tabs.rename("root", "Captured name", () => held.promise);
  const pinning = tabs.pin("root");
  tabs.preview("other");
  held.resolve(42);
  assertEquals(await renaming, 42);
  await pinning;
  assertEquals(named, ["Captured name"]);
  assertEquals(tabs.state.sessionID, "other");
  tabs.stop();
  const failed = createTabs(() => {
    throw Error("Must not promote a failed rename");
  });
  failed.update({ directory: "/p", entries: [entry("root")], inbox: meta });
  failed.preview("root");
  await assertRejects(
    () =>
      failed.rename(
        "root",
        "Rejected",
        () => Promise.reject(Error("Native refused")),
      ),
    Error,
    "Native refused",
  );
  assertEquals(failed.tabs().map((tab) => tab.kind), ["phantom"]);
  failed.stop();
});
