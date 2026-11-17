// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  Checkouts,
  checkoutsMigrations,
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
import { test } from "../../support/resources.ts";

test("leaf activity restores only its own policy and repo context, including late topology and persisted unseen state", async () => {
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
  const idle: IndexEntry = {
    id: "tstv1-leaf",
    directory: "/work/one/src",
    projectID: "repo",
    title: "Leaf",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const seed = (directory: string) => ({
    directory,
    hasSessions: directory !== "/repo",
    sessionCount: directory === "/repo" ? 0 : 1,
    lastActivity: 2,
    authority: "current" as const,
    topology: {
      repoID: "repo",
      canonicalRoot: "/repo",
      leafDirectory: directory,
      ...(directory !== "/repo" ? { parentDirectory: "/repo" } : {}),
    },
  });
  let owner: InboxFeature | undefined;
  try {
    for (const user of ["alice", "bob"]) {
      for (const directory of ["/repo", "/work/one", "/work/two"]) {
        stores.projects.add(user, directory);
        stores.projects.inactive(user, directory, true);
      }
    }
    index.upsert({
      ...idle,
      status: "busy",
      activity: { work: { keys: ["run"], fresh: true } },
    });
    owner = new InboxFeature(stores, index, "alice", () => Promise.resolve([]));
    index.projectSeeds([seed("/repo"), seed("/work/one"), seed("/work/two")]);
    const view = { epoch: 1, directory: "/work/one", crumbs: [], rows: [] };
    assertEquals(owner.get(view).tasks.length, 0);
    const task = stores.tasks.create(idle.directory, "Nested task", [idle.id]);
    assertEquals(owner.get(view).tasks.map((t) => [t.id, t.directory]), [[
      task.id,
      idle.directory,
    ]]);
    stores.tasks.create(idle.directory, "Later nested task");
    assertEquals(owner.get(view).tasks.length, 2);
    assertEquals(owner.keys(view).includes(idle.id), true);
    for (const user of ["alice", "bob"]) {
      assertEquals(stores.projects.get(user, "/repo").inactive, false);
      assertEquals(stores.projects.get(user, "/work/one").inactive, false);
      assertEquals(stores.projects.get(user, "/work/two").inactive, true);
    }
    index.upsert({ ...idle, activity: { terminal: 10 } });
    stores.seen.acknowledge("bob", idle.id, 10);
    for (const user of ["alice", "bob"]) {
      for (const directory of ["/repo", "/work/one"]) {
        stores.projects.inactive(user, directory, true);
      }
    }
    owner.close();
    owner = new InboxFeature(stores, index, "alice", () => Promise.resolve([]));
    index.projectSeeds([seed("/repo"), seed("/work/one"), seed("/work/two")]);
    assertEquals(stores.projects.get("alice", "/work/one").inactive, false);
    assertEquals(stores.projects.get("bob", "/work/one").inactive, true);
    assertEquals(stores.projects.get("bob", "/repo").inactive, true);
    assertEquals(stores.projects.get("alice", "/work/two").inactive, true);
  } finally {
    owner?.close();
    db.close();
  }
});

test("recorded-root admission reactivates the resolved leaf and context without restoring a quiet sibling", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
    checkoutsMigrations,
  ], { busyms: 0 });
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
    checkouts: new Checkouts(db),
  };
  const index = new IndexStore();
  const owner = new InboxFeature(
    stores,
    index,
    "alice",
    () => Promise.resolve([]),
  );
  try {
    for (const directory of ["/repo", "/tree", "/quiet"]) {
      stores.projects.add("alice", directory);
      stores.projects.inactive("alice", directory, true);
    }
    index.projectSeeds([{
      directory: "/tree/sub",
      hasSessions: true,
      sessionCount: 1,
      lastActivity: 2,
      authority: "current",
      identities: [{
        source: "fixture",
        repoID: "repo",
        canonicalRoot: "/repo",
        recordedRoot: null,
        inventory: [],
      }],
    }]);
    const active: IndexEntry = {
      id: "active",
      directory: "/tree/sub",
      projectID: "repo",
      title: "Active",
      timeCreated: 1,
      timeUpdated: 2,
      archived: false,
      status: "busy",
      digest: { state: "digesting", revision: 0, turns: {} },
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
      activity: { work: { keys: ["run"], fresh: true } },
    };
    index.upsert(active);
    stores.projects.inactive("alice", "/repo", true);
    assertEquals(stores.projects.get("alice", "/tree").inactive, true);
    index.upsert({ ...active, checkoutRoot: "/tree" });
    assertEquals(stores.projects.get("alice", "/tree").inactive, false);
    assertEquals(stores.projects.get("alice", "/repo").inactive, false);
    assertEquals(stores.projects.get("alice", "/quiet").inactive, true);
    assertEquals(index.getMetadata(active.id)?.directory, "/tree/sub");
  } finally {
    owner.close();
    db.close();
  }
});
