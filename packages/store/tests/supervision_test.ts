// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  Seen,
  seenMigrations,
} from "@otk/store";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("terminal acknowledgements are per-user, monotone, transactional and independent of old observation clocks", async () => {
  const path = await tempDir("supervision-store-");
  let db = new OtkDb(path, [seenMigrations, finishesMigrations], {
    busyms: 5000,
  });
  try {
    const seen = new Seen(db, () => 999999),
      finishes = new Finishes(db, () => 999999);
    seen.mark("alice", "s");
    finishes.record("s");
    assertEquals(seen.tokens().map((row) => row.time), [0]);
    assertEquals(finishes.tokens(), {});
    finishes.observe("s", 100);
    seen.acknowledge("alice", "s", 100);
    finishes.observe("s", 200);
    // Delayed viewing of the old terminal cannot acknowledge the new one.
    assertEquals(seen.acknowledge("alice", "s", 100), 100);
    finishes.observe("s", 50);
    assertEquals(finishes.tokens(), { s: 200 });
    assertEquals(seen.tokens().map((row) => [row.user, row.time]), [[
      "alice",
      100,
    ]]);
    assertThrows(() =>
      db.write((tx) => {
        seen.acknowledge("bob", "s", 200, tx);
        throw new Error("rollback");
      })
    );
    assertEquals(seen.tokens().length, 1);
    assertThrows(() => seen.acknowledge("alice", "s", -1));
    db.close();
    db = new OtkDb(path, [seenMigrations, finishesMigrations], {
      busyms: 5000,
    });
    assertEquals(new Finishes(db).tokens(), { s: 200 });
    assertEquals(new Seen(db).tokens().map((row) => row.time), [100]);
  } finally {
    db.close();
  }
});

test("v1 seen/finish upgrades preserve observation clocks without inventing acknowledgements", async () => {
  const path = await tempDir("supervision-upgrade-");
  const old = new OtkDb(
    path,
    [seenMigrations, finishesMigrations].map((feature) => ({
      ...feature,
      migrations: feature.migrations.slice(0, 1),
    })),
    { busyms: 5000 },
  );
  old.connection.exec(
    "INSERT INTO session_seen VALUES('alice','s',999); INSERT INTO session_finishes VALUES('s',1000)",
  );
  old.close();
  const db = new OtkDb(path, [seenMigrations, finishesMigrations], {
    busyms: 5000,
  });
  try {
    assertEquals(new Seen(db).list("alice"), { s: 999 });
    assertEquals(new Finishes(db).list(), { s: 1000 });
    assertEquals(new Seen(db).tokens().map((row) => row.time), [0]);
    assertEquals(new Finishes(db).tokens(), {});
  } finally {
    db.close();
  }
});
