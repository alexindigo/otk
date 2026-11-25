// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { test } from "../../support/resources.ts";
import { fixture } from "../../support/config.ts";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { IndexStore } from "../../../core/index/store.ts";
import type { IndexMetadata } from "@otk/protocol";
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

test("an unseen failed top-level run blocks every rollup until seen (2.72)", async () => {
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
  const entry: IndexMetadata = {
    id: "failed-root",
    directory: "/p",
    projectID: "p",
    title: "Failed root",
    archived: false,
    status: "idle",
    timeCreated: 1,
    timeUpdated: 20,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
    activity: { terminal: 20, terminalOrigin: "live", outcome: "failed" },
  };
  // Read the actual published wire shape, usable on pre-M3 ride as well.
  const snapshot = async () =>
    JSON.parse(JSON.stringify(await feature.snapshot())).inbox;
  const keys = [
    "session:failed-root",
    "checkout:/p",
    "project:/p",
    "global:global",
  ];
  try {
    index.reset([entry]);
    const failed = await snapshot();
    assertEquals(failed.supervision, undefined);
    assertEquals(failed.summaries["/p"].status, "blocked");
    for (const key of keys) {
      assertEquals(failed.entities[key].state, "blocked", key);
      assertEquals(failed.entities[key].counts.blocked, 1, key);
      assertEquals(failed.entities[key].counts.unseen, 1, key);
    }
    assertEquals(failed.entities["session:failed-root"].cause, "failure");
    // A permission cannot make an unseen run failure wait for permission grace.
    index.upsert({
      ...entry,
      activity: {
        ...entry.activity,
        permissions: { keys: ["per_new"], fresh: true },
      },
    });
    assertEquals(
      (await snapshot()).entities["session:failed-root"].cause,
      "failure",
    );
    index.upsert(entry);
    stores.seen.acknowledge("alice", entry.id, 20);
    const seen = await snapshot();
    for (const key of keys) {
      assertEquals(seen.entities[key].state, "none", key);
      assertEquals(seen.entities[key].counts.blocked, 0, key);
      assertEquals(seen.entities[key].counts.unseen, 0, key);
    }
    // Seeing a failure clears attention, never its historical run outcome.
    assertEquals(seen.entities["session:failed-root"].outcome, "failed");
  } finally {
    feature.close();
    db.close();
  }
});
