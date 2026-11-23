// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { assertEquals } from "@std/assert";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import {
  entityKey,
  type EntityState,
  type IndexEntry,
  type IndexMetadata,
  type ServerFrame,
  taskEntityID,
} from "@otk/protocol";
import { EntityStates } from "../../../core/index/entity-states.ts";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { ProjectSummaries } from "../../../core/index/project-summaries.ts";
import { IndexStore } from "../../../core/index/store.ts";
import { fixture } from "../../support/config.ts";

const base: IndexMetadata = {
  id: "s",
  directory: "/p",
  projectID: "p",
  title: "session",
  archived: false,
  status: "idle",
  timeCreated: 1,
  timeUpdated: 1,
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
};
const keys = (...values: string[]) => ({ keys: values, fresh: true });

function owner() {
  const entries = new Map<string, IndexMetadata>();
  const published: { upserts: EntityState[]; removals: string[] }[] = [];
  const family = {
    getMetadata: (id: string) => entries.get(id),
    ancestors(id: string) {
      const result: string[] = [];
      let parent = entries.get(id)?.parentID;
      while (parent && !result.includes(parent)) {
        result.push(parent);
        parent = entries.get(parent)?.parentID;
      }
      return result;
    },
    descendants(id: string) {
      const ids = new Set([id]);
      for (const current of ids) {
        for (const entry of entries.values()) {
          if (entry.parentID === current) ids.add(entry.id);
        }
      }
      return ids;
    },
  };
  const supervision = new SessionSupervision();
  const states = new EntityStates(
    supervision,
    family,
    (upserts, removals) =>
      published.push({ upserts: [...upserts], removals: [...removals] }),
  );
  const put = (entry: IndexMetadata, seen = 0) => {
    entries.set(entry.id, entry);
    return states.session(entry, seen);
  };
  const get = (id: string) => states.get(entityKey("session", id));
  return { entries, published, states, supervision, put, get };
}

test("each supervision verdict maps to one session lamp state and cause", () => {
  const o = owner();
  o.put(base);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("s")?.counts, {
    blocked: 0,
    working: 0,
    finished: 0,
    unseen: 0,
  });
  o.put({ ...base, activity: { work: keys("run") } });
  assertEquals(o.get("s")?.state, "working");
  assertEquals(o.get("s")?.previous, "none");
  assertEquals(o.get("s")?.evidence?.work, true);
  assertEquals(o.get("s")?.counts.working, 1);
  o.put({
    ...base,
    activity: { work: keys("run"), permissions: keys("per_1") },
    attention: { ...base.attention, permissions: 1 },
  });
  assertEquals(o.get("s")?.state, "blocked");
  assertEquals(o.get("s")?.cause, "permission");
  assertEquals(o.get("s")?.previous, "working");
  // Work evidence stays visible while the blocker wins.
  assertEquals(o.get("s")?.evidence?.work, true);
  assertEquals(o.get("s")?.evidence?.permissions, 1);
  assertEquals(o.get("s")?.evidence?.requests?.permissions, [{ id: "per_1" }]);
  // A question is never graced, so it wins the cause over a permission.
  o.put({
    ...base,
    activity: {
      work: keys("run"),
      permissions: keys("per_1"),
      inputs: keys("que_1"),
    },
  });
  assertEquals(o.get("s")?.cause, "question");
  assertEquals(o.get("s")?.evidence?.requests?.questions, [{ id: "que_1" }]);
  o.put({ ...base, activity: { terminal: 50, outcome: "succeeded" } });
  assertEquals(o.get("s")?.state, "finished");
  assertEquals(o.get("s")?.cause, undefined);
  assertEquals(o.get("s")?.previous, "blocked");
  assertEquals(o.get("s")?.counts, {
    blocked: 0,
    working: 0,
    finished: 1,
    unseen: 1,
  });
  assertEquals(o.get("s")?.terminal, 50);
  assertEquals(o.get("s")?.outcome, "succeeded");
  // Seen: no evidence is grey (D6).
  o.put({ ...base, activity: { terminal: 50, outcome: "succeeded" } }, 50);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("s")?.counts.unseen, 0);
});

test("auto-approved permissions do not block and carry no request identities", () => {
  const o = owner();
  o.supervision.permissions(() => 0);
  o.put({
    ...base,
    activity: { work: keys("run"), permissions: keys("per_1") },
    attention: { ...base.attention, permissions: 1 },
  });
  assertEquals(o.get("s")?.state, "working");
  assertEquals(o.get("s")?.evidence?.permissions, 0);
  assertEquals(o.get("s")?.evidence?.requests?.permissions, []);
});

test("a failed helper delivered to its parent stays blocked until seen (C1 unchanged)", () => {
  const o = owner();
  o.put({ ...base, id: "parent" });
  const helper: IndexMetadata = {
    ...base,
    id: "helper",
    parentID: "parent",
    activity: {
      terminal: 70,
      outcome: "failed",
      delivered: { parentID: "parent", receipt: "r", terminal: 70 },
    },
  };
  o.put(helper);
  assertEquals(o.get("helper")?.state, "blocked");
  assertEquals(o.get("helper")?.cause, "failedHelper");
  assertEquals(o.get("helper")?.outcome, "failed");
  // The parent's own lamp is its own state (D35); the child is evidence.
  assertEquals(o.get("parent")?.state, "none");
  assertEquals(o.get("parent")?.evidence?.descendants.blocked, 1);
  // An unseen failure is immediate, so a pending permission cannot grace it.
  o.put({
    ...helper,
    activity: { ...helper.activity, permissions: keys("per_1") },
  });
  assertEquals(o.get("helper")?.cause, "failedHelper");
  o.put(helper, 70);
  assertEquals(o.get("helper")?.state, "none");
  assertEquals(o.get("parent")?.evidence?.descendants.blocked, 0);
  // A succeeded helper's delivery is its acknowledgement (D58).
  o.put({ ...helper, activity: { ...helper.activity, outcome: "succeeded" } });
  assertEquals(o.get("helper")?.state, "none");
});

test("descendant evidence follows moves, deletion and removal without touching own state", () => {
  const o = owner();
  o.put({ ...base, id: "a" });
  o.put({ ...base, id: "b" });
  const child = {
    ...base,
    id: "c",
    parentID: "a",
    activity: { work: keys("run") },
  };
  o.put(child);
  assertEquals(o.get("a")?.evidence?.descendants.working, 1);
  o.put({ ...child, parentID: "b" });
  assertEquals(o.get("a")?.evidence?.descendants.working, 0);
  assertEquals(o.get("b")?.evidence?.descendants.working, 1);
  assertEquals(o.get("b")?.state, "none");
  o.published.length = 0;
  o.put({ ...child, parentID: "b", deleted: { at: 1, how: "provider" } });
  assertEquals(o.get("c"), undefined);
  assertEquals(o.get("b")?.evidence?.descendants.working, 0);
  assertEquals(o.published.flatMap((p) => p.removals), [
    entityKey("session", "c"),
  ]);
  o.put(child);
  o.entries.delete("c");
  o.published.length = 0;
  o.states.remove("c");
  assertEquals(o.get("c"), undefined);
  assertEquals(o.get("a")?.evidence?.descendants.working, 0);
  assertEquals(o.published.at(-1)?.removals, [entityKey("session", "c")]);
});

test("an unchanged session publishes nothing", () => {
  const o = owner();
  const entry = { ...base, activity: { work: keys("run") } };
  o.put(entry);
  o.published.length = 0;
  o.put(entry);
  assertEquals(o.published, []);
});

test("task projections share the state owner and update only containing groups", () => {
  const o = owner();
  const local = taskEntityID("task"), following = taskEntityID("task", true);
  o.put({ ...base, id: "parent", activity: { terminal: 10 } });
  o.put({
    ...base,
    id: "helper",
    parentID: "parent",
    directory: "/other",
    activity: { work: keys("run") },
  });
  o.states.membership(
    new Map([[local, ["parent"]], [following, ["parent", "helper"]]]),
  );
  const get = (id: string) => o.states.get(entityKey("task", id));
  assertEquals(get(local)?.state, "finished");
  assertEquals(get(following)?.state, "working");
  assertEquals(get(following)?.counts.unseen, 1);
  o.published.length = 0;
  o.put({
    ...base,
    id: "helper",
    parentID: "parent",
    directory: "/other",
    activity: { permissions: keys("per_helper") },
  });
  assertEquals(get(following)?.state, "blocked");
  assertEquals(get(following)?.cause, "permission");
  assertEquals(get(following)?.requests, [{ id: "per_helper" }]);
  assertEquals(
    o.published.flatMap((p) => p.upserts).filter((v) => v.kind === "task").map((
      v,
    ) => v.id),
    [following],
  );
  // Changing membership retires the old contribution without changing sessions.
  o.states.membership(new Map([[local, ["parent", "helper"]]]));
  assertEquals(get(following), undefined);
  assertEquals(get(local)?.state, "blocked");
  o.states.remove("helper");
  assertEquals(get(local)?.state, "finished");
  assertEquals(get(local)?.requests, undefined);
});

test("the inbox publishes session entities with the snapshot and as lease patches", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db, () => 100),
    tasks: new Tasks(db),
    seen: new Seen(db, () => 100),
    finishes: new Finishes(db, () => 100),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore();
  const feature = new InboxFeature(
    stores,
    index,
    "alice",
    () => Promise.resolve([]),
  );
  const entry: IndexEntry = {
    ...base,
    digest: { state: "digesting", revision: 0, turns: {} },
  };
  const frames: ServerFrame[] = [];
  const stop = feature.listen((frame) => frames.push(frame));
  try {
    index.reset([entry]);
    const key = entityKey("session", "s");
    assertEquals(feature.get().entities?.[key]?.state, "none");
    index.upsert({ ...entry, activity: { work: keys("run") } });
    await Promise.resolve();
    await Promise.resolve();
    const ops = frames.flatMap((frame) =>
      frame.t === "inbox.patch" ? frame.ops : []
    );
    const upsert = ops.find((op) => op.op === "entity.upsert");
    assertEquals(
      upsert?.op === "entity.upsert" ? upsert.value.state : undefined,
      "working",
    );
    assertEquals(
      (await feature.baseline()).inbox.entities?.[key]?.state,
      "working",
    );
    // A lease names only its sessions; other sessions' entities stay out,
    // while per-user aggregates reach every view.
    const leased = Object.keys(
      feature.get({ epoch: 0, crumbs: [], rows: [] }, new Set()).entities ??
        {},
    );
    assertEquals(leased.filter((key) => key.startsWith("session:")), []);
    assertEquals(leased.includes(entityKey("global", "global")), true);
  } finally {
    stop();
    feature.close();
    db.close();
  }
});

test("the inbox publishes both D8 task projections and refreshes state, moves and membership", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore();
  const feature = new InboxFeature(
    stores,
    index,
    "alice",
    () => Promise.resolve([]),
  );
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  const frames: ServerFrame[] = [];
  const stop = feature.listen((frame) => frames.push(frame));
  const views: ReturnType<InboxFeature["open"]>[] = [];
  try {
    const task = stores.tasks.create("/p", "Task", ["parent"]);
    const parent = { ...base, id: "parent", activity: { terminal: 10 } };
    const child = {
      ...base,
      id: "child",
      directory: "/other",
      parentID: "parent",
      activity: { work: keys("run") },
    };
    index.reset([parent, child]);
    await settle();
    assertEquals(
      Object.values(feature.get().entities ?? {}).filter((v) =>
        v.kind === "task"
      ),
      [],
    );
    for (const followParent of [false, true]) {
      views.push(
        feature.open(
          () => ({
            epoch: 0,
            directory: "/p",
            crumbs: [],
            rows: [],
            tasksFollowParent: followParent,
          }),
          String(followParent),
          () => new Set(["parent", "child"]),
        ),
      );
    }
    await settle();
    const get = (follow = false) =>
      feature.get().entities
        ?.[entityKey("task", taskEntityID(task.id, follow, "/p"))];
    assertEquals(get()?.state, "finished");
    assertEquals(get(true)?.state, "working");
    index.upsert({ ...child, activity: { permissions: keys("per_child") } });
    await settle();
    assertEquals(get(true)?.state, "blocked");
    assertEquals(get()?.state, "finished");
    assertEquals(
      frames.some((frame) =>
        frame.t === "inbox.patch" &&
        frame.ops.some((op) =>
          op.op === "entity.upsert" &&
          op.value.id === taskEntityID(task.id, true, "/p") &&
          op.value.state === "blocked"
        )
      ),
      true,
    );
    index.upsert({ ...child, directory: "/p" });
    await settle();
    assertEquals(get()?.state, "working");
    assertEquals(get()?.counts.unseen, 1);
    stores.tasks.close(task.id);
    await settle();
    assertEquals(get(), undefined);
    assertEquals(get(true), undefined);
    // A phantom is an unpinned task/family, not its root session's own lamp.
    assertEquals(
      feature.get().entities
        ?.[entityKey("task", taskEntityID("parent", true, "/p", "session"))]
        ?.state,
      "working",
    );
    assertEquals(
      feature.get().entities?.[entityKey("session", "parent")]?.state,
      "finished",
    );
    for (const view of views) view.close?.();
    views.length = 0;
    await settle();
    assertEquals(
      Object.values(feature.get().entities ?? {}).filter((v) =>
        v.kind === "task"
      ),
      [],
    );
  } finally {
    for (const view of views) view.close?.();
    stop();
    feature.close();
    db.close();
  }
});

function summaries(marks: (id: string) => { seen: number; finish: number }) {
  const owner = new ProjectSummaries(marks, () => {});
  owner.authority("current");
  owner.seed(["/repo", "/repo/tree"].map((directory) => ({
    directory,
    hasSessions: true,
    sessionCount: 1,
    lastActivity: 1,
    authority: "current" as const,
    topology: {
      repoID: "repo",
      canonicalRoot: "/repo",
      leafDirectory: directory,
      ...(directory === "/repo" ? {} : { parentDirectory: "/repo" }),
    },
  })));
  const state = (kind: "checkout" | "project" | "global", id: string) =>
    owner.states.get(entityKey(kind, id));
  return { owner, state };
}
const row = (
  id: string,
  directory: string,
  activity: IndexMetadata["activity"],
  parentID?: string,
): IndexMetadata => ({
  ...base,
  id,
  directory,
  projectID: "repo",
  ...(parentID ? { parentID } : {}),
  activity,
});

test("live 2.61 shape: a working project with two unseen finishes is green with unseen 2", () => {
  const { owner, state } = summaries(() => ({ seen: 10, finish: 0 }));
  owner.entry(row("main", "/repo", { terminal: 20, work: keys("shell") }));
  owner.entry(
    row("helper", "/repo", { terminal: 30, work: keys("run") }, "main"),
  );
  assertEquals(state("checkout", "/repo")?.state, "working");
  assertEquals(state("checkout", "/repo")?.counts.unseen, 2);
  assertEquals(state("project", "/repo")?.state, "working");
  assertEquals(state("project", "/repo")?.counts.unseen, 2);
  assertEquals(owner.values.get("/repo")?.status, "working");
  assertEquals(owner.values.get("/repo")?.unseenCount, 2);
  assertEquals(state("global", "global")?.counts, {
    blocked: 0,
    working: 2,
    finished: 0,
    unseen: 2,
  });
});

test("X10 shape: a working helper wins the repository while the main session stays finished", () => {
  const { owner, state } = summaries(() => ({ seen: 0, finish: 0 }));
  owner.entry(row("main", "/repo", { terminal: 20 }));
  owner.entry(
    row("helper", "/repo/tree", { terminal: 5, work: keys("run") }, "main"),
  );
  assertEquals(
    owner.states.get(entityKey("session", "main"))?.state,
    "finished",
  );
  assertEquals(state("checkout", "/repo/tree")?.state, "working");
  assertEquals(state("project", "/repo")?.state, "working");
  assertEquals(state("project", "/repo")?.counts.finished, 1);
  assertEquals(owner.values.get("/repo")?.status, "working");
  // Moving out of a checkout moves its contribution, nothing is rescanned.
  owner.remove("helper");
  assertEquals(state("checkout", "/repo/tree")?.state, "none");
  assertEquals(state("project", "/repo")?.state, "finished");
  assertEquals(state("project", "/repo")?.previous, "working");
});

test("a fresh location form blocks its checkout and project with cause form", () => {
  const { owner, state } = summaries(() => ({ seen: 0, finish: 0 }));
  owner.entry(row("main", "/repo/tree", { work: keys("run") }));
  owner.locationForms({ "/repo/tree": 1 });
  assertEquals(state("checkout", "/repo/tree")?.state, "blocked");
  assertEquals(state("checkout", "/repo/tree")?.cause, "form");
  assertEquals(state("project", "/repo")?.state, "blocked");
  assertEquals(state("project", "/repo")?.cause, "form");
  assertEquals(owner.values.get("/repo")?.status, "blocked");
  owner.locationForms({});
  assertEquals(state("project", "/repo")?.state, "working");
});

test("an aggregate blocked only by permissions shares their grace cause", () => {
  const { owner, state } = summaries(() => ({ seen: 0, finish: 0 }));
  const asking = row("a", "/repo", { permissions: keys("per_1") });
  owner.entry({ ...asking, attention: { ...base.attention, permissions: 1 } });
  assertEquals(state("project", "/repo")?.cause, "permission");
  assertEquals(state("global", "global")?.cause, "permission");
  assertEquals(state("project", "/repo")?.requests, [{ id: "per_1" }]);
  // An equal-count replacement is a new identity, so its grace starts anew.
  owner.entry({
    ...row("a", "/repo", { permissions: keys("per_2") }),
    attention: { ...base.attention, permissions: 1 },
  });
  assertEquals(state("project", "/repo")?.requests, [{ id: "per_2" }]);
  assertEquals(state("checkout", "/repo")?.requests, [{ id: "per_2" }]);
  owner.entry(row("b", "/repo", { inputs: keys("que_1") }));
  assertEquals(state("project", "/repo")?.state, "blocked");
  assertEquals(state("project", "/repo")?.cause, undefined);
  assertEquals(state("project", "/repo")?.requests, undefined);
});

test("a received operation is work on its target session and its wait blocks it immediately", () => {
  const o = owner();
  const entry = {
    ...base,
    activity: { terminal: 5, outcome: "succeeded" as const },
  };
  o.put(entry, 5);
  assertEquals(o.get("s")?.state, "none");
  o.states.operation("s", "working");
  o.put(entry, 5);
  assertEquals(o.get("s")?.state, "working");
  assertEquals(o.get("s")?.evidence?.work, true);
  assertEquals(o.get("s")?.counts.working, 1);
  // An operation waiting for input is immediate, never graced as a permission.
  o.states.operation("s", "blocked");
  o.put({
    ...entry,
    activity: { ...entry.activity, permissions: keys("per_1") },
  }, 5);
  assertEquals(o.get("s")?.state, "blocked");
  assertEquals(o.get("s")?.cause, "operation");
  o.states.operation("s");
  o.put(entry, 5);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("s")?.previous, "blocked");
});

test("the inbox borrows received operations by target session", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db, () => 100),
    tasks: new Tasks(db),
    seen: new Seen(db, () => 100),
    finishes: new Finishes(db, () => 100),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore();
  const feature = new InboxFeature(
    stores,
    index,
    "alice",
    () => Promise.resolve([]),
  );
  const operations = new Map<string, "working" | "blocked">([["s", "working"]]);
  let notify = (_id: string) => {};
  try {
    index.reset([base]);
    feature.operationAttention(
      (id) => operations.get(id),
      () => [...operations.keys()],
      (changed) => {
        notify = changed;
        return () => {};
      },
    );
    const key = entityKey("session", "s");
    assertEquals(feature.get().entities?.[key]?.state, "working");
    operations.set("s", "blocked");
    notify("s");
    assertEquals(feature.get().entities?.[key]?.cause, "operation");
    operations.delete("s");
    notify("s");
    assertEquals(feature.get().entities?.[key]?.state, "none");
  } finally {
    feature.close();
    db.close();
  }
});
