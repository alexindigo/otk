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
} from "@otk/protocol";
import { EntityStates } from "../../../core/index/entity-states.ts";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { InboxFeature } from "../../../core/features/inbox.ts";
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
    // A lease names only its sessions; other sessions' entities stay out.
    assertEquals(
      Object.keys(
        feature.get({ epoch: 0, crumbs: [], rows: [] }, new Set()).entities ??
          {},
      ),
      [],
    );
  } finally {
    stop();
    feature.close();
    db.close();
  }
});
