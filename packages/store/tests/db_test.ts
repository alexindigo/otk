// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type FeatureMigrations,
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
} from "@otk/store";
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
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name!='otk_migrations' ORDER BY name",
  ).all();
}
function versions(db: DatabaseSync): unknown[] {
  return db.prepare(
    "SELECT feature,version FROM otk_migrations ORDER BY feature,version",
  ).all();
}
const shippedVersions = [
  { feature: "frecency", version: 1 },
  { feature: "prefs", version: 1 },
];

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
    // Applied SQL must not even be read during the one-time legacy mapping.
    const unavailable = new URL("file:///missing-already-applied.sql");
    const db = new OtkDb(
      root,
      migrations.map((feature) => ({
        ...feature,
        migrations: feature.feature === "prefs" || version === 2
          ? [{ version: 1, sql: unavailable }]
          : feature.migrations,
      })),
    );
    try {
      assertEquals(
        db.connection.prepare("PRAGMA user_version").get()!.user_version,
        version,
      );
      assertEquals(versions(db.connection), shippedVersions);
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
    const reopened = new OtkDb(root, migrations);
    assertEquals(versions(reopened.connection), shippedVersions);
    assertEquals(new Prefs(reopened, prefsOptions).get().thinking, "show");
    reopened.close();
  }
});

Deno.test("feature upgrade lists reject gaps, duplicates and reordering before mutation", async () => {
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
      [migrations[0], migrations[0]],
      [{ feature: "invalid", migrations: [{ version: 2, sql: "SELECT 1" }] }],
      [{ feature: "invalid", migrations: [{ version: 0, sql: "SELECT 1" }] }],
      [{ feature: "invalid", migrations: [{ version: 1.5, sql: "SELECT 1" }] }],
      [{
        feature: "invalid",
        migrations: [{ version: 1, sql: "SELECT 1" }, {
          version: 1,
          sql: "SELECT 1",
        }],
      }],
      [{
        feature: "invalid",
        migrations: [{ version: 2, sql: "SELECT 1" }, {
          version: 1,
          sql: "SELECT 1",
        }],
      }],
      [{ feature: "", migrations: [] }],
    ]
  ) {
    assertThrows(
      () => new OtkDb(root, invalid),
      Error,
      invalid[0].feature === "invalid"
        ? "Expected invalid migration"
        : "Invalid or duplicate migration feature",
    );
  }
  const untouched = new DatabaseSync(join(root, "otk.db"));
  try {
    assertEquals(schema(untouched), before);
    assertEquals(versions(untouched), shippedVersions);
    assertEquals(untouched.prepare("SELECT * FROM prefs").all(), [{
      key: "timestamps",
      value: "true",
      updated: 123,
    }]);
  } finally {
    untouched.close();
  }
});

Deno.test("a failed feature rolls back all pending SQL and versions, releases connection and can retry", async () => {
  const root = await fixture();
  const failed: readonly FeatureMigrations[] = [
    {
      feature: "first",
      migrations: [{
        version: 1,
        sql:
          "CREATE TABLE first (value TEXT); INSERT INTO first VALUES('kept')",
      }],
    },
    {
      feature: "second",
      migrations: [
        { version: 1, sql: "CREATE TABLE second (value TEXT)" },
        {
          version: 2,
          sql:
            "INSERT INTO second VALUES('rollback'); INSERT INTO missing VALUES('fail')",
        },
      ],
    },
  ];
  assertThrows(() => new OtkDb(root, failed));
  const raw = new DatabaseSync(join(root, "otk.db"));
  try {
    assertEquals(versions(raw), [{ feature: "first", version: 1 }]);
    assertEquals(schema(raw).map((row) => (row as { name: string }).name), [
      "first",
    ]);
    assertEquals(raw.prepare("SELECT value FROM first").get()!.value, "kept");
  } finally {
    raw.close();
  }
  const retried = new OtkDb(root, [failed[0], {
    feature: "second",
    migrations: [failed[1].migrations[0], {
      version: 2,
      sql: "INSERT INTO second VALUES('retried')",
    }],
  }]);
  try {
    assertEquals(versions(retried.connection), [
      { feature: "first", version: 1 },
      { feature: "second", version: 1 },
      { feature: "second", version: 2 },
    ]);
    assertEquals(
      retried.connection.prepare("SELECT value FROM second").get()!.value,
      "retried",
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
    feature: "custom",
    migrations: [{
      version: 1,
      sql:
        "CREATE TABLE custom (value TEXT); INSERT INTO custom VALUES('standalone')",
    }],
  }]);
  assertEquals(
    schema(db.connection).map((row) => (row as { name: string }).name),
    ["custom"],
  );
  db.close();
  const reopened = new OtkDb(root, [{
    feature: "custom",
    migrations: [{
      version: 1,
      sql: new URL("file:///missing-already-applied.sql"),
    }],
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

Deno.test("fresh features start at v1, compose in any order and upgrade without editing others", async () => {
  const root = await fixture();
  const first = new OtkDb(root, [frecencyMigrations]);
  new Frecency(first, frecencyOptions).bump("/project", "README.md");
  assertEquals(versions(first.connection), [{
    feature: "frecency",
    version: 1,
  }]);
  assertEquals(
    schema(first.connection).map((row) => (row as { name: string }).name),
    ["frecency"],
  );
  first.close();
  const notes: FeatureMigrations = {
    feature: "notes",
    migrations: [
      {
        version: 1,
        sql:
          "CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES('original')",
      },
    ],
  };
  const second = new OtkDb(root, [notes, frecencyMigrations, prefsMigrations]);
  new Prefs(second, prefsOptions).set("thinking", "show");
  assertEquals(versions(second.connection), [shippedVersions[0], {
    feature: "notes",
    version: 1,
  }, shippedVersions[1]]);
  second.close();
  const upgraded: FeatureMigrations = {
    ...notes,
    migrations: [
      { version: 1, sql: new URL("file:///do-not-replay.sql") },
      {
        version: 2,
        sql:
          "ALTER TABLE notes ADD COLUMN extra TEXT; UPDATE notes SET extra='upgraded'",
      },
    ],
  };
  // A smaller composition preserves unselected features and their records.
  const third = new OtkDb(root, [upgraded]);
  assertEquals(third.connection.prepare("SELECT * FROM notes").all(), [{
    value: "original",
    extra: "upgraded",
  }]);
  assertEquals(versions(third.connection), [
    shippedVersions[0],
    { feature: "notes", version: 1 },
    { feature: "notes", version: 2 },
    shippedVersions[1],
  ]);
  third.close();
  const reordered = new OtkDb(root, [
    prefsMigrations,
    upgraded,
    frecencyMigrations,
  ]);
  assertEquals(new Prefs(reordered, prefsOptions).get().thinking, "show");
  assertEquals(
    new Frecency(reordered, frecencyOptions).list("/project")[0].score,
    1,
  );
  reordered.close();
});

Deno.test("unknown or noncontiguous applied versions reject every selected feature before pending SQL", async () => {
  for (const invalid of [0, 2, 3]) {
    const root = await fixture(), db = new OtkDb(root, migrations);
    db.connection.exec("DELETE FROM otk_migrations WHERE feature='prefs'");
    if (invalid !== 0) {
      db.connection.exec("INSERT INTO otk_migrations VALUES('prefs',1)");
    }
    // 0 models a gap at v1; 2 a newer version; 3 a gap after v1.
    db.connection.prepare("INSERT INTO otk_migrations VALUES('prefs',?)").run(
      invalid === 0 ? 2 : invalid,
    );
    const before = versions(db.connection);
    db.close();
    assertThrows(
      () =>
        new OtkDb(root, [
          {
            feature: "pending",
            migrations: [{
              version: 1,
              sql: "CREATE TABLE pending (value TEXT)",
            }],
          },
          ...migrations,
        ]),
      Error,
      "Unsupported otk.db feature prefs version",
    );
    const raw = new DatabaseSync(join(root, "otk.db"));
    assertEquals(versions(raw), before);
    assertEquals(
      raw.prepare("SELECT name FROM sqlite_master WHERE name='pending'").all(),
      [],
    );
    raw.close();
  }
});

Deno.test("unsupported legacy versions fail without mapping or data changes", async () => {
  for (const version of [-1, 3, 99]) {
    const root = await fixture(),
      original = new DatabaseSync(join(root, "otk.db"));
    original.exec(
      `${legacyPrefs} INSERT INTO prefs VALUES('thinking','"show"',123); PRAGMA user_version=${version}`,
    );
    const before = schema(original);
    original.close();
    assertThrows(
      () => new OtkDb(root, migrations),
      Error,
      `Unsupported legacy otk.db schema ${version}`,
    );
    const raw = new DatabaseSync(join(root, "otk.db"));
    assertEquals(schema(raw), before);
    assertEquals(
      raw.prepare("PRAGMA user_version").get()!.user_version,
      version,
    );
    assertEquals(raw.prepare("SELECT * FROM prefs").all(), [{
      key: "thinking",
      value: '"show"',
      updated: 123,
    }]);
    assertEquals(
      raw.prepare("SELECT name FROM sqlite_master WHERE name='otk_migrations'")
        .all(),
      [],
    );
    raw.close();
  }
});

Deno.test("legacy mapping records all old features even for a smaller composition and runs only once", async () => {
  const root = await fixture(),
    original = new DatabaseSync(join(root, "otk.db"));
  original.exec(`${legacyPrefs} ${legacyFrecency} PRAGMA user_version=2`);
  original.close();
  const mapped = new OtkDb(root, [prefsMigrations]);
  assertEquals(versions(mapped.connection), shippedVersions);
  mapped.connection.exec("PRAGMA user_version=999");
  mapped.close();
  const reopened = new OtkDb(root, [frecencyMigrations]);
  assertEquals(versions(reopened.connection), shippedVersions);
  assertEquals(
    reopened.connection.prepare("PRAGMA user_version").get()!.user_version,
    999,
  );
  reopened.close();
});
