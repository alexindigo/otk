// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
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
} from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";

test("metadata deltas carry final committed keys and clocks, isolate observers and vanish on rollback", async () => {
  const errors: unknown[] = [];
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { observerError: (e) => errors.push(e) });
  try {
    let now = 100;
    const projects = new Projects(db, () => now),
      seen = new Seen(db, () => now),
      finishes = new Finishes(db, () => now),
      templates = new ProjectTemplates(db);
    projects.discover("/p");
    projects.materialize("alice");
    projects.materialize("bob");
    const changes: unknown[] = [];
    for (const owner of [projects, seen, finishes, templates]) {
      owner.listen(() => {
        throw new Error("observer");
      });
      owner.listen((value) => changes.push(value));
    }
    const mutate = () =>
      db.write((tx) => {
        projects.visit("alice", "/p", tx);
        projects.inactive("alice", "/p", true, tx);
        seen.mark("alice", "s", tx);
        now = 80;
        assertEquals(seen.mark("alice", "s", tx), 100);
        finishes.record("s", tx);
        templates.set(["/a/{project}"], tx);
        templates.set(["/b/{project}"], tx);
        assertEquals(changes, []);
      });
    mutate();
    assertEquals(changes, [
      { user: "alice", upsert: [projects.get("alice", "/p")], remove: [] },
      { user: "alice", session: "s", time: 100 },
      { session: "s", time: 80 },
      { templates: ["/b/{project}"] },
    ]);
    assertEquals(errors.length, 4);
    changes.length = 0;
    assertThrows(() =>
      db.write((tx) => {
        finishes.record("rolled-back", tx);
        templates.set([], tx);
        throw new Error("rollback");
      })
    );
    assertEquals(changes, []);
    assertEquals(finishes.time("rolled-back"), 0);
    const prepare = db.connection.prepare.bind(db.connection);
    const sql: string[] = [];
    db.connection.prepare = (query) => {
      sql.push(query);
      return prepare(query);
    };
    projects.list("alice");
    projects.get("alice", "/p");
    assertEquals(sql.length, 2);
    assertEquals(sql.every((s) => s.startsWith("SELECT")), true);
    assertEquals(projects.get("bob", "/p").inactive, false);
  } finally {
    db.close();
  }
});
