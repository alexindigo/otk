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
import { ManualClock } from "../../support/manual-clock.ts";

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
  const clock = new ManualClock();
  const mature = () => clock.runNext();
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
    clock,
  );
  const put = (entry: IndexMetadata, seen = 0) => {
    entries.set(entry.id, entry);
    return states.session(entry, seen);
  };
  const get = (id: string) => states.get(entityKey("session", id));
  return { entries, published, states, supervision, put, get, mature };
}

test("successful session settles only after native confirmation of its current work", () => {
  const o = owner();
  const success = {
    terminal: 50,
    outcome: "succeeded" as const,
    terminalOrigin: "live" as const,
  };
  const put = (activity: IndexMetadata["activity"]) =>
    o.put({ ...base, activity });
  const settlement = () => o.get(base.id)?.evidence?.settlement?.id;
  put({ work: keys("run") });
  put(success);
  assertEquals(settlement(), undefined);
  for (const pending of ["queued", "parked", "starting", "returning"]) {
    put({ ...success, completion: { pending: [pending], confirmed: 50 } });
    assertEquals(settlement(), undefined);
    assertEquals(o.get(base.id)?.state, "working");
    assertEquals(o.states.composerLink(base.id), "running");
  }
  put({ ...success, completion: { pending: [], confirmed: 49 } });
  assertEquals(settlement(), undefined);
  o.put({
    ...base,
    activityAuthority: "stale",
    activity: { ...success, completion: { pending: [], confirmed: 50 } },
  });
  assertEquals(settlement(), undefined);
  put({
    ...success,
    completion: { pending: [], confirmed: 50 },
    inputs: keys("question"),
  });
  assertEquals(settlement(), undefined);
  put({ ...success, completion: { pending: [], confirmed: 50 } });
  assertEquals(settlement(), 50);
  assertEquals(o.get(base.id)?.state, "finished");
  const child = { ...base, id: "helper", parentID: base.id };
  o.put({ ...child, activity: { terminal: 58, outcome: "succeeded" } });
  assertEquals(settlement(), 50, "an unseen child end is not pending delivery");
  o.put({
    ...child,
    activity: {
      terminal: 58,
      outcome: "succeeded",
      delivered: { parentID: base.id, receipt: "result", terminal: 58 },
    },
  });
  assertEquals(settlement(), 50);
  const publications = o.published.length;
  put({ ...success, completion: { pending: [], confirmed: 50 } });
  assertEquals(o.published.length, publications);
  put({ ...success, work: keys("next-run") });
  assertEquals(settlement(), undefined);
  o.supervision.freshness(false);
  put({ ...success, completion: { pending: [], confirmed: 50 } });
  assertEquals(settlement(), undefined);
});

test("composer link owns native work and task helper activity independently of lamps", () => {
  const o = owner(), link = () => o.states.composerLink(base.id);
  o.put(base);
  assertEquals(link(), "none");
  o.states.operation(base.id, "working");
  o.put(base);
  assertEquals(o.get(base.id)?.state, "working");
  assertEquals(link(), "none");
  o.states.operation(base.id);
  o.put({ ...base, activity: { work: keys("native-run") } });
  assertEquals(o.get(base.id)?.evidence?.nativeRun, true);
  assertEquals(link(), "running");
  o.put({
    ...base,
    activity: {
      work: {
        ...keys("old-shell"),
        items: [{
          id: "old-shell",
          kind: "shell",
          label: "Shell",
          title: "sleep",
          startedAt: Date.now() - 7 * 86_400_000,
        }],
      },
      inputs: keys("live-question"),
    },
  });
  assertEquals(o.get(base.id)?.state, "blocked");
  assertEquals(o.get(base.id)?.evidence?.nativeRun, undefined);
  assertEquals(o.get(base.id)?.shells?.state, "working");
  assertEquals(link(), "running");
  o.put(base);
  const helper = { ...base, id: "helper", parentID: base.id, directory: "/q" };
  o.put({ ...helper, activity: { terminal: 70, outcome: "succeeded" } });
  assertEquals(link(), "idle");
  o.put({
    ...helper,
    activity: { work: keys("cross-checkout-run") },
  });
  o.put({
    ...helper,
    id: "waiting",
    activity: { inputs: keys("another-question") },
  });
  assertEquals(o.get(base.id)?.state, "none");
  assertEquals(link(), "running");
  o.supervision.freshness(false);
  o.put({ ...helper, activity: { work: keys("cross-checkout-run") } });
  o.put({ ...helper, id: "waiting" });
  assertEquals(link(), "none");
});

test("terminal dependencies stay independent of freshness and session lamps", () => {
  const o = owner();
  let running = 2;
  o.states.terminalOwners(() => running);
  o.supervision.freshness(false);
  const native = o.put(base);
  assertEquals(native.state, "none");
  assertEquals(o.get(base.id)?.state, "none");
  assertEquals(o.get(base.id)?.dependencies, 2);
  o.put({ ...base, deleted: { at: 1, how: "provider" } });
  assertEquals(o.get(base.id), undefined);
  running = 0;
  o.put(base);
  assertEquals(o.get(base.id)?.dependencies, undefined);
});

test("D72: a helper leaves the roster after human seen or matching parent delivery", () => {
  const o = owner();
  const entry = { ...base, parentID: "root" };
  o.put({
    ...entry,
    activity: {
      work: {
        ...keys("run"),
        items: [{
          id: "run",
          kind: "execution",
          label: "Execution",
          title: "Work",
          startedAt: 10,
        }],
      },
    },
  });
  assertEquals(o.get("s")?.evidence?.run, { startedAt: 10 });
  const terminal = {
    ...entry,
    activity: { terminal: 50, outcome: "succeeded" as const },
  };
  o.put(terminal);
  assertEquals(o.get("s")?.evidence?.helper, "finished");
  o.put(terminal, 50);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("s")?.evidence?.helper, undefined);
  assertEquals(o.get("s")?.evidence?.run, { startedAt: 10, endedAt: 50 });
  for (
    const delivered of [
      { parentID: "foreign", receipt: "result", terminal: 50 },
      { parentID: "root", receipt: "", terminal: 50 },
      { parentID: "root", receipt: "result", terminal: 49 },
    ]
  ) {
    o.put({ ...terminal, activity: { ...terminal.activity, delivered } });
    assertEquals(o.get("s")?.evidence?.helper, "finished");
  }
  o.put({
    ...terminal,
    activity: {
      ...terminal.activity,
      delivered: { parentID: "root", receipt: "result", terminal: 50 },
    },
  });
  assertEquals(o.get("s")?.evidence?.helper, undefined);
  o.put({ ...entry, activity: { work: keys("rerun"), terminal: 50 } }, 50);
  assertEquals(o.get("s")?.evidence?.run, undefined);
  o.put({
    ...entry,
    activity: {
      work: {
        ...keys("rerun"),
        items: [{
          id: "rerun",
          kind: "execution",
          label: "Execution",
          title: "Rerun",
          startedAt: 60,
        }],
      },
      terminal: 50,
    },
  }, 50);
  assertEquals(o.get("s")?.evidence?.run, { startedAt: 60 });
});

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
  assertEquals(o.get("s")?.state, "working");
  o.mature();
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

test("current diagnostics retain their row marker without inventing a failed run", () => {
  const o = owner();
  const observed: IndexMetadata = {
    ...base,
    attention: {
      ...base.attention,
      error: "Unavailable",
      errorState: {
        revision: 1,
        observations: [{ id: "http", source: "http", message: "Unavailable" }],
      },
    },
  };
  o.put(observed);
  assertEquals(o.get("s")?.evidence?.error, true);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("s")?.outcome, undefined);
  assertEquals(o.get("s")?.evidence?.failure, undefined);
  o.put({
    ...observed,
    attention: {
      ...base.attention,
      errorState: {
        revision: 2,
        observations: observed.attention.errorState!.observations.map((
          item,
        ) => ({
          ...item,
          cleared: true,
        })),
      },
    },
  });
  assertEquals(o.get("s")?.evidence?.error, undefined);
  o.put({
    ...base,
    attention: { ...base.attention, error: "Legacy current diagnostic" },
  });
  assertEquals(o.get("s")?.evidence?.error, true);
  o.put(base);
  assertEquals(o.get("s")?.evidence?.error, undefined);
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

test("retry evidence shares the interpreter's native freshness rather than retained metadata", () => {
  const o = owner();
  const row: IndexMetadata = {
    ...base,
    status: "retry",
    retry: { attempt: 2, message: "Waiting", next: 100 },
    activity: { work: keys("retry") },
  };
  o.put(row);
  assertEquals(o.get("s")?.evidence?.retry?.attempt, 2);
  o.supervision.freshness(false);
  o.put(row);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("s")?.evidence?.retry, undefined);
});

test("D81: a delivered failed helper leaves attention but preserves its failure", () => {
  const o = owner();
  const parent = { ...base, id: "parent", activity: { work: keys("parent") } };
  o.put(parent);
  const helper: IndexMetadata = {
    ...base,
    id: "helper",
    parentID: "parent",
    activity: {
      terminal: 70,
      outcome: "failed",
    },
  };
  o.put(helper);
  const roster = () => o.states.get(entityKey("task", "session/parent"));
  assertEquals(o.get("helper")?.state, "blocked");
  assertEquals(o.get("helper")?.cause, "failedHelper");
  assertEquals(o.get("helper")?.evidence?.helper, "needsYou");
  assertEquals(roster()?.state, "blocked");
  assertEquals(roster()?.helpers?.counts.needsYou, 1);
  assertEquals(o.get("helper")?.outcome, "failed");
  // The parent's own lamp is its own state (D35); the child is evidence.
  assertEquals(o.get("parent")?.state, "working");
  assertEquals(o.get("parent")?.evidence?.descendants.blocked, 1);
  // An unseen failure is immediate, so a pending permission cannot grace it.
  o.put({
    ...helper,
    activity: { ...helper.activity, permissions: keys("per_1") },
  });
  assertEquals(o.get("helper")?.cause, "failedHelper");
  // The existing blocker wins even after the child rewakes (F02).
  o.put({ ...helper, activity: { ...helper.activity, work: keys("new-run") } });
  assertEquals(o.get("helper")?.state, "blocked");
  assertEquals(o.get("helper")?.evidence?.helper, "needsYou");
  const delivered = { parentID: "parent", receipt: "r", terminal: 70 };
  o.put({ ...helper, activity: { ...helper.activity, delivered } });
  assertEquals(o.get("helper")?.state, "none");
  assertEquals(o.get("helper")?.outcome, "failed");
  assertEquals(o.get("helper")?.evidence?.helper, undefined);
  assertEquals(roster()?.state, "working");
  assertEquals(roster()?.helpers?.counts.needsYou ?? 0, 0);
  assertEquals(o.get("parent")?.evidence?.descendants.blocked, 0);
  // A succeeded helper's delivery is its acknowledgement (D58).
  o.put({
    ...helper,
    activity: { ...helper.activity, delivered, outcome: "succeeded" },
  });
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

test("2.99: only fresh shells in the session contribute to its shell roster and lamp", () => {
  const o = owner();
  const shell = {
    id: "shell",
    kind: "shell" as const,
    label: "Shell",
    title: "sleep 120",
    startedAt: 10,
  };
  const entry = {
    ...base,
    activity: {
      inputs: keys("pending-question"),
      work: {
        ...keys(shell.id, "run"),
        items: [shell, { ...shell, id: "ended" }, {
          ...shell,
          id: "run",
          kind: "execution" as const,
        }],
      },
    },
  };
  o.put(entry);
  o.put({
    ...base,
    id: "child",
    parentID: base.id,
    activity: {
      work: {
        ...keys("child-shell"),
        items: [{ ...shell, id: "child-shell" }],
      },
    },
  });
  const task = () => o.states.get(entityKey("task", "session/s"));
  assertEquals(task()?.state, "blocked");
  assertEquals(o.get(base.id)?.state, "blocked");
  const { kind: _kind, ...row } = shell;
  assertEquals(o.get(base.id)?.shells, {
    items: [row],
    count: 1,
    state: "working",
  });
  const empty = { items: [], count: 0, state: "none" } as const;
  o.put({
    ...entry,
    activity: {
      ...entry.activity,
      work: { ...entry.activity.work, fresh: false },
    },
  });
  assertEquals(o.get(base.id)?.shells, empty);
  o.put({
    ...entry,
    activity: {
      ...entry.activity,
      work: { ...entry.activity.work, ...keys("run") },
    },
  });
  assertEquals(o.get(base.id)?.shells, empty);
  assertEquals(o.get(base.id)?.evidence?.work, true);
  assertEquals(task()?.state, "blocked");
  assertEquals(o.get("child")?.shells?.count, 1);
});

test("live work belongs to the entity owner, including blocked helpers, title changes and retirement", () => {
  const o = owner();
  o.put({ ...base, id: "root" });
  const helper: IndexMetadata = {
    ...base,
    id: "child",
    parentID: "root",
    title: "Original helper",
    activity: { work: keys("native"), permissions: keys("permission") },
  };
  o.put(helper);
  o.mature();
  assertEquals(o.get("root")?.state, "none");
  assertEquals(
    o.get("root")?.evidence?.liveWork?.map((
      item,
    ) => [item.id, item.kind, item.title, item.state]),
    [["child", "helper", "Original helper", "blocked"]],
  );
  o.put({ ...helper, title: "Renamed helper" });
  assertEquals(o.get("root")?.evidence?.liveWork?.[0].title, "Renamed helper");
  o.put({ ...helper, activity: { work: keys("native") } });
  assertEquals(o.get("root")?.evidence?.liveWork?.[0].state, "working");
  o.put({ ...helper, activity: { terminal: 50 } });
  assertEquals(o.get("root")?.evidence?.liveWork, undefined);
  o.put({ ...helper, parentID: "other" });
  assertEquals(o.get("root")?.evidence?.liveWork, undefined);
});

test("a task keeps the same identity and permission grace across checkout boundaries", () => {
  const o = owner();
  o.put({ ...base, id: "parent", activity: { terminal: 10 } });
  o.states.roots(new Map([["parent", "task/review"]]));
  const child = {
    ...base,
    id: "helper",
    parentID: "parent",
    directory: "/other",
    activity: { permissions: keys("per_helper") },
  };
  o.put(child);
  o.mature();
  const get = () => o.states.get(entityKey("task", "task/review"));
  assertEquals(get()?.state, "blocked");
  assertEquals(get()?.cause, "permission");
  assertEquals(get()?.requests, [{ id: "per_helper" }]);
  o.entries.delete("helper");
  o.states.remove("helper");
  assertEquals(get()?.state, "finished");
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

test("the inbox leases one task identity independently of D8, and refreshes its state and membership", async () => {
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
  const clock = new ManualClock();
  const feature = new InboxFeature(
    stores,
    index,
    "alice",
    () => Promise.resolve([]),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clock,
  );
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  const frames: ServerFrame[] = [];
  const stop = feature.listen((frame) => frames.push(frame));
  const views: ReturnType<InboxFeature["open"]>[] = [];
  const demands: { rows: string[]; epoch: number }[] = [];
  const snapshotEntries = index.snapshotEntries.bind(index);
  let populationReads = 0;
  index.snapshotEntries = () => {
    populationReads++;
    return snapshotEntries();
  };
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
      const scope = {
        epoch: 0,
        directory: "/p",
        crumbs: [] as string[],
        rows: [] as string[],
        tasksFollowParent: followParent,
      };
      demands.push(scope);
      views.push(
        feature.open(
          () => scope,
          String(followParent),
          () => new Set(["parent", "child"]),
        ),
      );
    }
    await settle();
    const beforeRows = populationReads;
    demands[0].rows.push("parent");
    demands[0].epoch++;
    views[0].viewChanged?.();
    views[1].viewChanged?.();
    await settle();
    assertEquals(
      populationReads,
      beforeRows,
      "row-only scope changes cannot rebuild task membership",
    );
    const key = entityKey("task", taskEntityID("task", task.id));
    const get = () => feature.get().entities?.[key];
    // D78: both views publish the finished parent over the working helper.
    assertEquals(get()?.state, "finished");
    for (const view of views) {
      const frame = await view.snapshot!();
      assertEquals(
        frame?.t === "inbox.snapshot" && frame.inbox.entities?.[key]?.state,
        "finished",
      );
    }
    index.upsert({ ...child, activity: { permissions: keys("per_child") } });
    clock.runNext();
    await settle();
    assertEquals(get()?.state, "blocked");
    assertEquals(
      frames.some((frame) =>
        frame.t === "inbox.patch" &&
        frame.ops.some((op) =>
          op.op === "entity.upsert" &&
          op.value.id === taskEntityID("task", task.id) &&
          op.value.state === "blocked"
        )
      ),
      true,
    );
    index.upsert({ ...child, directory: "/p" });
    await settle();
    assertEquals(get()?.state, "finished");
    assertEquals(get()?.counts.unseen, 1);
    stores.tasks.close(task.id);
    await settle();
    assertEquals(get(), undefined);
    assertEquals(
      feature.get().entities
        ?.[entityKey("task", taskEntityID("session", "parent"))]?.state,
      "finished",
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
  const clock = new ManualClock();
  const owner = new ProjectSummaries(
    marks,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clock,
  );
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
  return { owner, state, clock };
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

test("2.61: two sessions working on newer runs stay green while keeping their unseen counts (D35/D69/D78)", () => {
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

test("D78: a finished main lights the repository yellow while its helper is working", () => {
  const { owner, state } = summaries(() => ({ seen: 0, finish: 0 }));
  owner.entry(row("main", "/repo", {}));
  owner.entry(
    row("helper", "/repo/tree", { terminal: 5, work: keys("run") }, "main"),
  );
  assertEquals(state("project", "/repo")?.state, "working");
  owner.entry(row("main", "/repo", { terminal: 20 }));
  assertEquals(
    owner.states.get(entityKey("session", "main"))?.state,
    "finished",
  );
  assertEquals(
    owner.states.get(entityKey("session", "helper"))?.state,
    "working",
  );
  assertEquals(state("checkout", "/repo/tree")?.state, "working");
  assertEquals(state("project", "/repo")?.state, "finished");
  assertEquals(state("project", "/repo")?.counts.finished, 1);
  assertEquals(owner.values.get("/repo")?.status, "finished");
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
  const { owner, state, clock } = summaries(() => ({ seen: 0, finish: 0 }));
  const asking = row("a", "/repo", { permissions: keys("per_1") });
  owner.entry({ ...asking, attention: { ...base.attention, permissions: 1 } });
  clock.runNext();
  assertEquals(state("project", "/repo")?.cause, "permission");
  assertEquals(state("global", "global")?.cause, "permission");
  assertEquals(state("project", "/repo")?.requests, [{ id: "per_1" }]);
  // An equal-count replacement is a new identity, so its grace starts anew.
  owner.entry({
    ...row("a", "/repo", { permissions: keys("per_2") }),
    attention: { ...base.attention, permissions: 1 },
  });
  assertEquals(state("project", "/repo")?.requests, undefined);
  clock.runNext();
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
  // D35/D69: an older unseen finish cannot mask work on that same session.
  o.put({ ...entry, activity: { ...entry.activity, terminal: 6 } }, 5);
  assertEquals(o.get("s")?.counts.unseen, 1);
  assertEquals(o.get("s")?.state, "working");
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
      (target) => operations.get(target.id),
      () => [...operations.keys()].map((id) => ({ kind: "session", id })),
      (changed) => {
        notify = (id) => changed({ kind: "session", id });
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

test("D78: an unseen finish beats a working checkout operation but not its blocker", () => {
  const { owner, state } = summaries(() => ({ seen: 0, finish: 0 }));
  owner.entry(row("main", "/repo", { terminal: 5 }));
  owner.states.checkoutOperation("/repo/tree", "working");
  owner.touch("/repo/tree");
  assertEquals(state("checkout", "/repo/tree")?.state, "working");
  assertEquals(state("project", "/repo")?.state, "finished");
  assertEquals(owner.values.get("/repo/tree")?.status, "working");
  owner.states.checkoutOperation("/repo/tree", "blocked");
  assertEquals(state("project", "/repo")?.state, "blocked");
  assertEquals(state("project", "/repo")?.cause, "operation");
  owner.states.checkoutOperation("/repo/tree");
  owner.touch("/repo/tree");
  assertEquals(state("project", "/repo")?.state, "finished");
  assertEquals(owner.values.get("/repo/tree")?.status, "none");
});

test("D78: a working checkout operation keeps a yellow leaf out of Archived", () => {
  const { states, put } = owner();
  const checkout = () => states.get(entityKey("checkout", "/p"));
  const archive = () => states.get(entityKey("archive", "p"));
  states.placement({
    directory: "/p",
    archived: true,
    availability: "removed",
    topology: { repoID: "p", canonicalRoot: "/repo", leafDirectory: "/p" },
  });
  states.member(base.id, "/p");
  put({ ...base, activity: { terminal: 10 } });
  assertEquals(archive()?.state, "finished");
  states.checkoutOperation("/p", "working");
  assertEquals(checkout()?.state, "finished");
  assertEquals(archive()?.state, "none");
  states.checkoutOperation("/p");
  assertEquals(archive()?.state, "finished");
});

test("a deleted member stops counting toward its project's unseen finishes", () => {
  const { owner, state } = summaries(() => ({ seen: 0, finish: 0 }));
  const child = row("child", "/repo", { terminal: 10 }, "parent");
  owner.entry(row("parent", "/repo", {}));
  owner.entry(child);
  assertEquals(state("project", "/repo")?.counts.unseen, 1);
  assertEquals(state("project", "/repo")?.state, "finished");
  owner.entry({ ...child, deleted: { at: 11, how: "provider" } });
  assertEquals(state("project", "/repo")?.counts.unseen, 0);
  assertEquals(state("project", "/repo")?.state, "none");
  assertEquals(owner.values.get("/repo")?.unseenCount, 0);
});
test("D79: project and task retain the oldest current native run, not the last update", () => {
  const o = owner();
  const task = "task/review", project = "/p", other = "other";
  o.states.project(project, [project]);
  o.states.roots(new Map([[base.id, task], [other, task]]));
  const update = (id: string, start?: number) => {
    o.put({
      ...base,
      id,
      activity: {
        work: start === undefined ? keys() : {
          ...keys(id),
          items: [{
            id,
            kind: "execution",
            label: "Execution",
            title: id,
            startedAt: start,
          }],
        },
      },
    });
    o.states.member(id, project);
  };
  const starts = () => [
    o.states.get(entityKey("task", task))?.runStartedAt,
    o.states.get(entityKey("project", project))?.runStartedAt,
  ];
  update(base.id, 60_000);
  update(other, 90_000);
  assertEquals(starts(), [60_000, 60_000]);
  update(base.id);
  assertEquals(starts(), [90_000, 90_000]);
  update(other);
  assertEquals(starts(), [undefined, undefined]);
});

test("D69/D70: one task spans checkouts and a project counts it once", () => {
  const o = owner();
  const get = (kind: EntityState["kind"], id: string) =>
    o.states.get(entityKey(kind, id));
  o.states.project("/repo", ["/p", "/other"]);
  o.put(base);
  o.states.roots(new Map([["s", "task/review"]]));
  o.states.member("s", "/p");
  o.states.member("helper", "/other");
  const helper = {
    ...base,
    id: "helper",
    parentID: "s",
    directory: "/other",
    activity: { work: keys("run") },
  };
  o.put(helper);
  assertEquals(o.get("s")?.state, "none");
  assertEquals(o.get("helper")?.state, "working");
  for (
    const [kind, id] of [
      ["task", "task/review"],
      ["checkout", "/p"],
      ["checkout", "/other"],
      ["project", "/repo"],
    ] as const
  ) {
    assertEquals(get(kind, id)?.state, "working");
    assertEquals(get(kind, id)?.counts.working, 1);
  }
  const terminal = {
    ...base,
    id: "old",
    parentID: "s",
    activity: { terminal: 51 },
  };
  o.put(terminal);
  assertEquals(get("task", "task/review")?.state, "finished", "D78");
  assertEquals(get("project", "/repo")?.counts.finished, 1);
  o.put({ ...terminal, activity: { inputs: keys("q") } });
  assertEquals(get("task", "task/review")?.state, "blocked");
  assertEquals(get("project", "/repo")?.counts.blocked, 1);
});

test("D70: moving a parent moves its entire subtree, and unlinking retires the old task", () => {
  const o = owner();
  const get = (id: string) => o.states.get(entityKey("task", id));
  o.put({ ...base, id: "a" });
  o.put({ ...base, id: "b" });
  const child = { ...base, id: "c", parentID: "a" };
  o.put(child);
  o.put({ ...base, id: "d", parentID: "c", activity: { work: keys("run") } });
  assertEquals(get("session/a")?.counts.working, 1);
  assertEquals(get("session/b")?.counts.working, 0);
  o.put({ ...child, parentID: "b" });
  assertEquals(get("session/a")?.counts.working, 0);
  assertEquals(get("session/b")?.counts.working, 1);
  o.states.roots(new Map([["b", "task/review"]]));
  assertEquals(get("session/b"), undefined);
  assertEquals(get("task/review")?.counts.working, 1);
  o.entries.delete("c");
  o.states.remove("c");
  assertEquals(get("task/review")?.counts.working, 0);
  assertEquals(o.get("d")?.state, "working");
  assertEquals(get("session/d")?.counts.working, 1);
});
test("D66/D58/D78/D81: one task publishes its ordered non-root dispositions", () => {
  const o = owner();
  o.put(base);
  const put = (
    n: number,
    activity: IndexMetadata["activity"],
    parentID = "s",
  ) =>
    o.put({
      ...base,
      id: `helper-${n}`,
      parentID,
      directory: n === 1 ? "/other" : base.directory,
      timeCreated: n,
      activity,
    });
  const running = (startedAt: number) => ({
    work: {
      ...keys("run"),
      items: [{
        id: "run",
        kind: "execution" as const,
        label: "Execution",
        title: "Run",
        startedAt,
      }],
    },
  });
  put(0, running(10));
  put(1, running(20));
  put(2, { ...running(30), inputs: keys("q") });
  put(3, running(15));
  put(3, { terminal: 50 });
  put(4, { terminal: 60 });
  put(5, {
    terminal: 70,
    outcome: "failed",
    delivered: { parentID: "s", receipt: "result", terminal: 70 },
  });
  put(6, { terminal: 80, outcome: "failed" }, "helper-0");
  const task = () => o.states.get(entityKey("task", "session/s"));
  assertEquals(task()?.helpers, {
    counts: { running: 2, needsYou: 2, finished: 2 },
    lamps: {
      all: { state: "blocked" },
      groups: {
        running: { state: "working" },
        needsYou: { state: "blocked" },
        finished: { state: "finished" },
      },
    },
    ids: [
      "helper-2",
      "helper-6",
      "helper-4",
      "helper-3",
      "helper-0",
      "helper-1",
    ],
  });
  assertEquals(o.get("s")?.evidence?.helper, undefined);
  assertEquals(o.get("helper-2")?.evidence?.helper, "needsYou");
  assertEquals(o.get("helper-5")?.state, "none");
  assertEquals(o.get("helper-5")?.evidence?.helper, undefined);
  assertEquals(o.get("helper-6")?.evidence?.helper, "needsYou");
  put(1, running(5));
  assertEquals(task()?.helpers?.ids.slice(-2), ["helper-1", "helper-0"]);
});
