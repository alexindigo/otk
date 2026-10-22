// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  Prefs,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { fixture, migrations, prefsOptions } from "./support.ts";
const inboxMigrations = [
  projectsMigrations,
  tasksMigrations,
  seenMigrations,
  finishesMigrations,
  projectTemplatesMigrations,
];

test("inbox features create independent fresh schemas and upgrade the previous schema without losing data", async () => {
  for (const upgrade of [false, true]) {
    const path = await fixture();
    if (upgrade) {
      const previous = new OtkDb(path, migrations);
      new Prefs(previous, prefsOptions).set("timestamps", true);
      previous.close();
    }
    let db = new OtkDb(path, [...migrations, ...inboxMigrations]);
    const projects = new Projects(db, () => 100);
    projects.discover("/auto");
    projects.add("alice", "/empty");
    const tasks = new Tasks(db), task = tasks.create("/auto", "exec");
    tasks.sessions(task.id, ["one", "two"]);
    new Seen(db, () => 200).mark("alice", "one");
    new Finishes(db, () => 150).record("one");
    new ProjectTemplates(db).set(["~/Projects/{project}"]);
    assertEquals(
      db.connection.prepare(
        "SELECT COUNT(DISTINCT feature) AS n FROM otk_migrations",
      ).get()?.n,
      7,
    );
    db.close();
    db = new OtkDb(path, [...inboxMigrations, ...migrations]);
    try {
      assertEquals(new Prefs(db, prefsOptions).get().timestamps, upgrade);
      assertEquals(
        new Projects(db).list("alice").map((
          p,
        ) => [p.directory, p.order, p.added]),
        [["/auto", 0, false], ["/empty", 1, true]],
      );
      assertEquals(new Tasks(db).get(task.id).sessions, ["one", "two"]);
      assertEquals(new Seen(db).list("alice"), { one: 200 });
      assertEquals(new Seen(db).list("bob"), {});
      assertEquals(new Finishes(db).list(), { one: 150 });
      assertEquals(new ProjectTemplates(db).list(), ["~/Projects/{project}"]);
    } finally {
      db.close();
    }
  }
});

test("project visits and inactive clocks are user-scoped, pause while inactive and resume without counting the pause", async () => {
  const db = new OtkDb(await fixture(), [projectsMigrations]);
  let now = 100;
  const projects = new Projects(db, () => now);
  try {
    projects.discover("/a");
    now = 200;
    projects.visit("alice", "/a");
    assertEquals(projects.get("bob", "/a").lastVisit, 100);
    now = 300;
    projects.inactive("alice", "/a", true);
    now = 900;
    assertEquals(projects.inactive("alice", "/a", true).inactiveAt, 300);
    const active = projects.inactive("alice", "/a", false);
    assertEquals(active.lastVisit, 800);
    assertEquals(active.inactiveAt, undefined);
    now = 1000;
    projects.inactive("alice", "/a", true);
    now = 2000;
    projects.visit("alice", "/a");
    now = 3000;
    assertEquals(projects.inactive("alice", "/a", false).lastVisit, 3000);
    assertEquals(projects.list("alice").length, 1);
    assertEquals(projects.get("bob", "/a").inactive, false);
  } finally {
    db.close();
  }
});

test("tasks retain ordered sessions, reject duplicate memberships atomically, reorder and close only their grouping", async () => {
  const db = new OtkDb(await fixture(), [tasksMigrations, finishesMigrations]);
  const tasks = new Tasks(db);
  try {
    const a = tasks.create("/p", "first"),
      b = tasks.create("/p", "second"),
      other = tasks.create("/q", "other");
    tasks.sessions(a.id, ["one", "two"]);
    tasks.sessions(a.id, ["two", "three", "one"]);
    tasks.sessions(b.id, ["four"]);
    const before = tasks.list().length;
    assertThrows(() => tasks.create("/p", "cannot steal", ["one"]));
    assertEquals(tasks.list().length, before);
    assertThrows(() => tasks.sessions(b.id, ["four", "one"]));
    assertEquals(tasks.get(b.id).sessions, ["four"]);
    assertEquals(tasks.get(a.id).sessions, ["two", "three", "one"]);
    tasks.sessions(a.id, ["three", "two"]);
    tasks.sessions(b.id, ["one", "four"]);
    assertEquals(tasks.rename(a.id, "execution").name, "execution");
    assertThrows(() => tasks.reorder("/p", [other.id, a.id]));
    assertEquals(tasks.reorder("/p", [b.id, a.id]).map((t) => t.id), [
      b.id,
      a.id,
    ]);
    new Finishes(db, () => 12).record("two");
    tasks.close(a.id);
    assertEquals(tasks.list("/p").map((t) => t.id), [b.id]);
    assertEquals(new Finishes(db).list(), { two: 12 });
    assertEquals(tasks.get(other.id).sessions, []);
  } finally {
    db.close();
  }
});

test("seen and finish clocks persist monotone timestamps and notify only after valid metadata writes", async () => {
  const db = new OtkDb(await fixture(), [
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  let now = 100, changes = 0;
  const seen = new Seen(db, () => now),
    finishes = new Finishes(db, () => now),
    templates = new ProjectTemplates(db);
  const stop = seen.listen(() => {
    changes++;
    assertEquals(seen.list("alice").one, 100);
  });
  try {
    seen.mark("alice", "one");
    stop();
    now = 50;
    assertEquals(seen.mark("alice", "one"), 100);
    finishes.record("one");
    now = 10;
    assertEquals(finishes.record("one"), 50);
    templates.set(["/a/{project}", "/b/{project}"]);
    assertThrows(() => templates.set(["duplicate", "duplicate"]));
    assertEquals(templates.list(), ["/a/{project}", "/b/{project}"]);
    assertThrows(() => seen.mark("alice", "\0"));
    assertEquals(changes, 1);
  } finally {
    db.close();
  }
});

test("composite preference defaults are detached on every read", async () => {
  const db = new OtkDb(await fixture(), migrations);
  const defaults = { thresholds: [2, 8, 24] };
  try {
    const prefs = new Prefs(db, {
      defaults,
      validate: (key, value): key is "thresholds" =>
        key === "thresholds" && Array.isArray(value),
      invalid: () => new Error("invalid"),
    });
    prefs.get().thresholds[0] = 99;
    assertEquals(prefs.get().thresholds, [2, 8, 24]);
    assertEquals(defaults.thresholds, [2, 8, 24]);
  } finally {
    db.close();
  }
});

test("explicit project additions stay private to their user while automatic discovery appends in each user's stable order", async () => {
  const db = new OtkDb(await fixture(), [projectsMigrations]);
  const projects = new Projects(db, () => 100);
  try {
    projects.add("alice", "/private");
    assertEquals(projects.list("bob"), []);
    projects.discover("/shared");
    projects.add("alice", "/another-private");
    projects.discover("/later");
    assertEquals(projects.list("alice").map((p) => [p.directory, p.order]), [
      ["/private", 0],
      ["/shared", 1],
      ["/another-private", 2],
      ["/later", 3],
    ]);
    assertEquals(projects.list("bob").map((p) => [p.directory, p.order]), [[
      "/shared",
      0,
    ], ["/later", 1]]);
    assertEquals(projects.get("bob", "/shared").added, false);
  } finally {
    db.close();
  }
});
