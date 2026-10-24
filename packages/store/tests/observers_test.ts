// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  permissionMigrations,
  PermissionStore,
  Prefs,
  prefsMigrations,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { fixture } from "./support.ts";
import { test } from "../../../tests/support/resources.ts";

test("committed metadata writes survive observer failure and notify independent listeners", async () => {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  const logged: unknown[][] = [], previous = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const projects = new Projects(db, () => 7),
      tasks = new Tasks(db),
      seen = new Seen(db, () => 8),
      finishes = new Finishes(db, () => 9),
      templates = new ProjectTemplates(db);
    let delivered = 0;
    const failure = new Error("observer failed after commit");
    for (const owner of [projects, tasks, seen, finishes, templates]) {
      owner.listen(() => {
        throw failure;
      });
      owner.listen(() => delivered++);
    }
    projects.discover("/p");
    assertEquals(projects.add("u", "/p").added, true);
    assertEquals(projects.visit("u", "/p").lastVisit, 7);
    assertEquals(projects.inactive("u", "/p", true).inactive, true);
    const task = tasks.create("/p", "name", ["a"]);
    assertEquals(tasks.rename(task.id, "renamed").name, "renamed");
    assertEquals(tasks.sessions(task.id, ["b"]).sessions, ["b"]);
    assertEquals(tasks.addSession(task.id, "c").sessions, ["b", "c"]);
    assertEquals(tasks.removeSession(task.id, "b").sessions, ["c"]);
    assertEquals(tasks.reorder("/p", [task.id]).length, 1);
    tasks.close(task.id);
    assertEquals(tasks.list(), []);
    assertEquals(seen.mark("u", "s"), 8);
    assertEquals(finishes.record("s"), 9);
    assertEquals(templates.set(["/root/{project}"]), ["/root/{project}"]);
    assertEquals(delivered, 14);
    assertEquals(logged.length, delivered);
    assert(logged.every((args) => args.includes(failure)));
    assertThrows(() => tasks.rename("missing", "bad"), Error, "Unknown task");
    assertEquals(delivered, 14, "rejected mutations never notify");
  } finally {
    console.error = previous;
    db.close();
  }
});

test("preference observers receive detached payloads without changing saved or returned values", async () => {
  const db = new OtkDb(await fixture(), [prefsMigrations]);
  const logged: unknown[][] = [], previous = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const prefs = new Prefs(db, {
      defaults: { nested: { values: ["original"] } },
      validate: (key, _value): key is "nested" => key === "nested",
      invalid: () => new Error("invalid"),
    });
    const failure = new Error("preference observer failed");
    prefs.listen((value) => {
      value.nested.values.push("injected");
      throw failure;
    });
    const values: unknown[] = [];
    const stop = prefs.listen((value) => values.push(value));
    const expected = { nested: { values: ["saved"] } };
    const returned = prefs.set("nested", expected.nested);
    assertEquals(returned, expected);
    assertEquals(values, [expected]);
    assertEquals(prefs.get(), expected);
    assertEquals(logged.length, 1);
    assert(logged[0].includes(failure));
    stop();
    prefs.set("nested", { values: ["next"] });
    assertEquals(values.length, 1);
  } finally {
    console.error = previous;
    db.close();
  }
});

test("store observer diagnostics preserve committed outcomes when the injected reporter fails", async () => {
  const failure = new Error("observer"), reportFailure = new Error("reporter");
  const reported: unknown[] = [],
    fallback: unknown[][] = [],
    previous = console.error;
  console.error = (...args) => fallback.push(args);
  const db = new OtkDb(await fixture(), [seenMigrations], {
    observerError: (error) => {
      reported.push(error);
      throw reportFailure;
    },
  });
  try {
    const seen = new Seen(db, () => 42);
    seen.listen(() => {
      throw failure;
    });
    let observed = 0;
    seen.listen(() => observed = seen.time("u", "s"));
    assertEquals(seen.mark("u", "s"), 42);
    assertEquals(observed, 42);
    assertEquals(reported, [failure]);
    const aggregate = fallback[0].find((value) =>
      value instanceof AggregateError
    );
    assert(aggregate instanceof AggregateError);
    assertEquals(aggregate.errors, [failure, reportFailure]);
  } finally {
    console.error = previous;
    db.close();
  }
});

test("permission journal returns committed intent identity despite observer failure", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]);
  const logged: unknown[][] = [], previous = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const permissions = new PermissionStore(db, () => 12);
    const failure = new Error("permission observer failed");
    permissions.listen((change) => {
      if (change.kind === "activity") change.sessions.push("injected");
      throw failure;
    });
    const changes: unknown[] = [];
    permissions.listen((change) => changes.push(change));
    permissions.setAuto("s", true);
    assertEquals(permissions.enabled(), ["s"]);
    const id = permissions.start({
      session: "s",
      requestID: "r",
      request: "{}",
      reply: "once",
      source: "manual",
    }, ["parent"]);
    assert(Number.isSafeInteger(id));
    assertEquals(permissions.list(["parent"])[0].id, id);
    permissions.finish(id, { outcome: "confirmed" });
    assertEquals(permissions.list(["s"])[0].outcome, "confirmed");
    assertEquals(changes, [
      { kind: "policy" },
      { kind: "activity", sessions: ["s", "parent"] },
      { kind: "activity", sessions: ["parent", "s"] },
    ]);
    assertEquals(logged.length, 3);
    assert(logged.every((args) => args.includes(failure)));
  } finally {
    console.error = previous;
    db.close();
  }
});
