// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { Frecency, type Migration, OtkDb, Prefs } from "@otk/store";
import {
  fixture,
  frecencyOptions,
  migrations,
  prefsOptions,
} from "./support.ts";

// Original schemas, independent of the extracted feature SQL. This models an
// existing app database, rather than using the new runner to create its fixture.
const legacyPrefs = `CREATE TABLE prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL
);`;
const legacyFrecency = `CREATE TABLE frecency (
  directory TEXT NOT NULL,
  path TEXT NOT NULL,
  score REAL NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY(directory, path)
);`;
function schema(db: DatabaseSync): unknown[] {
  return db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all();
}

Deno.test("original version 1 and 2 databases preserve schema, timestamps and data", async () => {
  for (const version of [1, 2]) {
    const root = await fixture(), path = join(root, "otk.db");
    const original = new DatabaseSync(path);
    original.exec(legacyPrefs);
    original.prepare("INSERT INTO prefs VALUES(?,?,?)").run(
      "thinking",
      '"show"',
      123,
    );
    if (version === 2) {
      original.exec(legacyFrecency);
      original.prepare("INSERT INTO frecency VALUES(?,?,?,?)").run(
        "/project",
        "/project/README.md",
        7,
        456,
      );
    }
    original.exec(`PRAGMA user_version=${version}`);
    const before = schema(original);
    original.close();
    const db = new OtkDb(root, migrations);
    try {
      assertEquals(
        db.connection.prepare("PRAGMA user_version").get()!.user_version,
        2,
      );
      assertEquals(
        db.connection.prepare("PRAGMA journal_mode").get()!.journal_mode,
        "wal",
      );
      assertEquals(
        db.connection.prepare("PRAGMA busy_timeout").get()!.timeout,
        5000,
      );
      assertEquals(new Prefs(db, prefsOptions).get().thinking, "show");
      assertEquals(
        db.connection.prepare("SELECT updated FROM prefs").get()!.updated,
        123,
      );
      const current = schema(db.connection);
      if (version === 2) {
        assertEquals(current, before);
        assertEquals(new Frecency(db, frecencyOptions).list("/project"), [{
          path: "/project/README.md",
          score: 7,
          last: 456,
        }]);
      } else {
        assertEquals(
          current.filter((row) => (row as { name: string }).name === "prefs"),
          before,
        );
        assertEquals(new Frecency(db, frecencyOptions).list("/project"), []);
      }
      assertEquals(current.map((row) => (row as { name: string }).name), [
        "frecency",
        "prefs",
      ]);
    } finally {
      db.close();
    }
  }
});

Deno.test("migration contributions reject gaps, duplicates and reordering before mutation", async () => {
  const root = await fixture(), db = new OtkDb(root, migrations);
  db.connection.prepare("INSERT INTO prefs VALUES(?,?,?)").run(
    "timestamps",
    "true",
    123,
  );
  const before = schema(db.connection);
  db.close();
  for (
    const invalid of [
      [migrations[1], migrations[0]],
      [migrations[0], migrations[0]],
      [migrations[1]],
      [{ id: 0, sql: "SELECT 1" }],
      [{ id: 1.5, sql: "SELECT 1" }],
    ]
  ) {
    assertThrows(() => new OtkDb(root, invalid), Error, "Expected migration");
  }
  const untouched = new DatabaseSync(join(root, "otk.db"));
  try {
    assertEquals(schema(untouched), before);
    assertEquals(
      untouched.prepare("PRAGMA user_version").get()!.user_version,
      2,
    );
    assertEquals(untouched.prepare("SELECT * FROM prefs").all(), [{
      key: "timestamps",
      value: "true",
      updated: 123,
    }]);
  } finally {
    untouched.close();
  }
});

Deno.test("a failed pending migration rolls back SQL and version, releases connection and can retry", async () => {
  const root = await fixture();
  const failed: readonly Migration[] = [
    {
      id: 1,
      sql: "CREATE TABLE first (value TEXT); INSERT INTO first VALUES('kept')",
    },
    {
      id: 2,
      sql:
        "CREATE TABLE second (value TEXT); INSERT INTO missing VALUES('fail')",
    },
  ];
  assertThrows(() => new OtkDb(root, failed));
  const raw = new DatabaseSync(join(root, "otk.db"));
  try {
    assertEquals(raw.prepare("PRAGMA user_version").get()!.user_version, 1);
    assertEquals(schema(raw).map((row) => (row as { name: string }).name), [
      "first",
    ]);
    assertEquals(raw.prepare("SELECT value FROM first").get()!.value, "kept");
  } finally {
    raw.close();
  }
  const retried = new OtkDb(root, [failed[0], {
    id: 2,
    sql: "CREATE TABLE second (value TEXT)",
  }]);
  try {
    assertEquals(
      retried.connection.prepare("PRAGMA user_version").get()!.user_version,
      2,
    );
    assertEquals(
      schema(retried.connection).map((row) => (row as { name: string }).name),
      ["first", "second"],
    );
  } finally {
    retried.close();
  }
});

Deno.test("public database accepts independent features and never reads or replays applied SQL", async () => {
  const root = await fixture();
  const db = new OtkDb(root, [{
    id: 1,
    sql:
      "CREATE TABLE custom (value TEXT); INSERT INTO custom VALUES('standalone')",
  }]);
  assertEquals(
    schema(db.connection).map((row) => (row as { name: string }).name),
    ["custom"],
  );
  db.close();
  const reopened = new OtkDb(root, [{
    id: 1,
    sql: new URL("file:///missing-already-applied.sql"),
  }]);
  try {
    assertEquals(
      reopened.connection.prepare("SELECT value FROM custom").get()!.value,
      "standalone",
    );
  } finally {
    reopened.close();
  }
});
