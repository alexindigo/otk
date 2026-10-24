// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { OtkDb } from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";

test("connection transaction commits values, rolls back errors and rejects nesting without retiring the outer transaction", async () => {
  const db = new OtkDb(await fixture(), []);
  try {
    db.connection.exec("CREATE TABLE sample(value TEXT)");
    const insert = db.connection.prepare("INSERT INTO sample VALUES(?)");
    assertEquals(
      db.transaction(() => {
        insert.run("saved");
        return 42;
      }),
      42,
    );
    const failure = new Error("original write failure");
    assertStrictEquals(
      assertThrows(() =>
        db.transaction(() => {
          insert.run("lost");
          throw failure;
        })
      ),
      failure,
    );
    db.transaction(() => {
      insert.run("outer");
      assertThrows(() => db.transaction(() => insert.run("inner")));
    });
    assertEquals(
      db.connection.prepare("SELECT value FROM sample").all().map((row) =>
        row.value
      ),
      ["saved", "outer"],
    );
  } finally {
    db.close();
  }
});

test("connection transaction retains the original failure when rollback also fails", async () => {
  const db = new OtkDb(await fixture(), []);
  try {
    const failure = new Error("write failed after native rollback");
    const error = assertThrows(() =>
      db.transaction(() => {
        db.connection.exec("ROLLBACK");
        throw failure;
      }), AggregateError);
    assertStrictEquals(error.cause, failure);
    assertStrictEquals(error.errors[0], failure);
    assertEquals(error.errors.length, 2);
    assertEquals(db.transaction(() => "still usable"), "still usable");
  } finally {
    db.close();
  }
});
