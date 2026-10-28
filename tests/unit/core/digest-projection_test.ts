// SPDX-License-Identifier: LGPL-3.0-only
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
import { IndexStore } from "../../../core/index/store.ts";
import { InboxFeature } from "../../../core/features/inbox.ts";
import type { SessionMetadata } from "@otk/protocol";
import { tempDir, test } from "../../support/resources.ts";
test("hydrated inbox observers perform zero SELECTs, preserve every finish edge and retain tombstone task membership", async () => {
  const db = new OtkDb(await tempDir("digest-projection-"), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  let clock = 1;
  const stores = {
    projects: new Projects(db, () => clock),
    tasks: new Tasks(db),
    seen: new Seen(db, () => clock),
    finishes: new Finishes(db, () => clock),
    templates: new ProjectTemplates(db),
  };
  stores.projects.add("alice", "/p");
  stores.projects.inactive("alice", "/p", true);
  const task = stores.tasks.create("/p", "Retained", ["tstv1-one"]);
  const index = new IndexStore(),
    feature = new InboxFeature(
      stores,
      index,
      "alice",
      () => Promise.resolve([]),
    );
  const entry: SessionMetadata = {
    id: "tstv1-one",
    directory: "/p",
    projectID: "p",
    title: "One",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const prepare = db.connection.prepare.bind(db.connection);
  let reads = 0;
  db.connection.prepare = (sql) => {
    if (/^\s*SELECT\b/i.test(sql)) reads++;
    return prepare(sql);
  };
  try {
    index.upsertMetadata(entry);
    assertEquals(reads, 0);
    index.upsertMetadata({ ...entry, status: "busy" });
    clock = 3;
    index.upsertMetadata(entry);
    clock = 4;
    index.upsertMetadata({ ...entry, status: "busy" });
    index.upsertMetadata(entry);
    index.applyDigest({
      id: entry.id,
      revision: 1,
      summary: { state: "ready", revision: 1 },
      turns: { upsert: {}, remove: [] },
      deleted: { at: 5, how: "provider" },
    });
    index.upsertMetadata(entry);
    assertEquals(reads, 0);
    assertEquals(stores.finishes.time(entry.id), 4);
    assertEquals(stores.tasks.get(task.id).sessions, [entry.id]);
    assertEquals(stores.projects.find("alice", "/p")?.inactive, false);
  } finally {
    feature.close();
    db.close();
  }
});
