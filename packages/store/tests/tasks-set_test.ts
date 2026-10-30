// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { OtkDb, Tasks, tasksMigrations } from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";

test("task reads use two set statements, retain empty groups and scope membership in SQL", async () => {
  const db = new OtkDb(await fixture(), [tasksMigrations]);
  try {
    const tasks = new Tasks(db);
    const first = tasks.create("/p", "First", ["two", "one"]);
    const empty = tasks.create("/p", "Empty");
    tasks.create("/q", "Other", ["foreign"]);
    const prepare = db.connection.prepare.bind(db.connection);
    const sql: string[] = [];
    db.connection.prepare = (query) => {
      sql.push(query);
      return prepare(query);
    };
    assertEquals(tasks.list("/p"), [first, empty]);
    assertEquals(sql.length, 2);
    assertEquals(sql.every((s) => s.includes("directory")), true);
    sql.length = 0;
    assertEquals(tasks.get(first.id), first);
    assertEquals(sql.length, 2);
    sql.length = 0;
    assertEquals(tasks.getMany([empty.id, first.id, first.id]), [first, empty]);
    assertEquals(sql.length, 2);
    sql.length = 0;
    assertEquals(tasks.getMany([]), []);
    assertEquals(sql, []);
    tasks.list = () => {
      throw new Error("No population read");
    };
    assertEquals(tasks.get(first.id), first);
    assertEquals(tasks.owner("one"), first.id);
    assertEquals(tasks.owners(["one", "missing"]), { one: first.id });
  } finally {
    db.close();
  }
});

test("task narrow grouping edits coalesce final detached records and rollback without publication", async () => {
  const db = new OtkDb(await fixture(), [tasksMigrations]);
  try {
    const tasks = new Tasks(db);
    const first = tasks.create("/p", "First", ["a", "b"]);
    const second = tasks.create("/p", "Second", ["c"]);
    const changes: unknown[] = [];
    tasks.listen((value) => changes.push(value));
    tasks.addSession(first.id, "a");
    tasks.removeSession(first.id, "absent");
    tasks.sessions(first.id, ["a", "b"]);
    assertEquals(changes, []);
    assertThrows(() =>
      db.write((tx) => {
        tasks.removeSessions(["a", "c"], tx);
        throw new Error("rollback");
      })
    );
    assertEquals(tasks.get(first.id), first);
    assertEquals(changes, []);
    const result = db.write((tx) => {
      tasks.rename(first.id, "Renamed", tx);
      tasks.removeSessions(["a", "c"], tx);
      assertEquals(changes, []);
      return tasks.get(first.id);
    });
    assertEquals(changes, [{
      upsert: [{ ...first, name: "Renamed", sessions: ["b"] }, {
        ...second,
        sessions: [],
      }],
      remove: [],
    }]);
    result.sessions.push("not stored");
    assertEquals(tasks.get(first.id).sessions, ["b"]);
    assertThrows(() => tasks.addSession(second.id, "b"));
  } finally {
    db.close();
  }
});
