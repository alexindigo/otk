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
import type { IndexEntry } from "@otk/protocol";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { IndexStore } from "../../../core/index/store.ts";
import { fixture } from "../../support/config.ts";

test("core records real status edges at the single index owner and clears persisted inactive marks for working, blocked and unread activity", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  let now = 100;
  const stores = {
    projects: new Projects(db, () => now),
    tasks: new Tasks(db),
    seen: new Seen(db, () => now),
    finishes: new Finishes(db, () => now),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore(),
    feature = new InboxFeature(stores, index, "alice");
  const idle: IndexEntry = {
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
  try {
    index.reset([idle]);
    assertEquals(stores.finishes.list(), {});
    assertEquals(stores.projects.list("alice"), []);
    stores.projects.add("alice", "/p");
    stores.projects.add("bob", "/p");
    stores.projects.inactive("alice", "/p", true);
    stores.projects.inactive("bob", "/p", true);
    now = 200;
    index.upsert({ ...idle, status: "busy" });
    assertEquals(stores.projects.get("alice", "/p").inactive, false);
    assertEquals(stores.projects.get("bob", "/p").inactive, false);
    now = 300;
    index.upsert(idle);
    assertEquals(stores.finishes.time("s"), 300);
    now = 400;
    index.upsert(idle);
    assertEquals(stores.finishes.time("s"), 300);
    stores.seen.mark("alice", "s");
    stores.seen.mark("bob", "s");
    stores.projects.inactive("alice", "/p", true);
    now = 500;
    index.upsert({ ...idle, attention: { ...idle.attention, permissions: 1 } });
    assertEquals(stores.projects.get("alice", "/p").inactive, false);
    index.upsert(idle);
    stores.projects.inactive("alice", "/p", true);
    stores.projects.inactive("bob", "/p", true);
    now = 600;
    stores.finishes.record("s");
    stores.seen.mark("bob", "s");
    index.reset([idle]);
    assertEquals(stores.projects.get("alice", "/p").inactive, false);
    assertEquals(stores.projects.get("bob", "/p").inactive, true);
    assertEquals(stores.finishes.time("s"), 600);
    feature.close();
    index.upsert({ ...idle, status: "busy" });
    index.upsert(idle);
    assertEquals(stores.finishes.time("s"), 600);
  } finally {
    feature.close();
    db.close();
  }
});

test("synchronous index observers see committed detached metadata on reset and every same-batch transition", () => {
  const index = new IndexStore(), transitions: string[] = [];
  const entry: IndexEntry = {
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
  const stop = index.observe((next, previous) => {
    assertEquals(index.get(next.id)!.status, next.status);
    transitions.push(`${previous?.status ?? "none"}>${next.status}`);
    next.title = "must not leak";
  });
  index.reset([entry]);
  index.upsert({ ...entry, status: "busy" });
  index.upsert(entry);
  assertEquals(transitions, ["none>idle", "idle>busy", "busy>idle"]);
  assertEquals(index.get("s")!.title, "session");
  stop();
  index.upsert(entry);
  assertEquals(transitions.length, 3);
});

test("explicit deletion removes membership in every task, including out-of-window sessions, but window eviction keeps it", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  const index = new IndexStore(),
    feature = new InboxFeature(
      stores,
      index,
      "local",
      () => Promise.resolve([]),
    );
  try {
    const a = stores.tasks.create("/p", "A", ["deleted", "retained"]);
    const b = stores.tasks.create("/p", "B", ["also-deleted"]);
    index.reset([]);
    assertEquals(stores.tasks.get(a.id).sessions, ["deleted", "retained"]);
    const frames: unknown[] = [];
    const stop = feature.listen((frame) => frames.push(frame));
    index.remove("deleted");
    index.remove("also-deleted");
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(stores.tasks.get(a.id).sessions, ["retained"]);
    assertEquals(stores.tasks.get(b.id).sessions, []);
    assertEquals(feature.get().tasks.flatMap((task) => task.sessions), [
      "retained",
    ]);
    assertEquals(frames.length > 0, true);
    stop();
  } finally {
    feature.close();
    db.close();
  }
});
