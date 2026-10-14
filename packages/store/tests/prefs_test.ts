// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { OtkDb, Prefs } from "@otk/store";
import { defaults, fixture, migrations, prefsOptions } from "./support.ts";
Deno.test("otk.db migrates transactionally, uses WAL and preserves prefs on reopen", async () => {
  const root = await fixture();
  const db = new OtkDb(root, migrations), prefs = new Prefs(db, prefsOptions);
  assertEquals(
    db.connection.prepare("PRAGMA journal_mode").get()!.journal_mode,
    "wal",
  );
  assertEquals(
    db.connection.prepare("PRAGMA user_version").get()!.user_version,
    2,
  );
  assertEquals(prefs.get(), defaults);
  const changes: unknown[] = [],
    stop = prefs.listen((prefs) => changes.push(prefs));
  prefs.set("thinking", "show");
  prefs.set("timestamps", true);
  assertThrows(() => prefs.set("timestamps", 1));
  stop();
  assertEquals(changes.length, 2);
  db.close();
  const reopened = new OtkDb(root, migrations);
  assertEquals(new Prefs(reopened, prefsOptions).get(), {
    ...defaults,
    thinking: "show",
    timestamps: true,
  });
  reopened.close();
  const future = new DatabaseSync(join(root, "otk.db"));
  future.exec("PRAGMA user_version=3");
  future.close();
  assertThrows(
    () => new OtkDb(root, migrations),
    Error,
    "Unsupported otk.db schema",
  );
  const untouched = new DatabaseSync(join(root, "otk.db"), { readOnly: true });
  assertEquals(
    untouched.prepare("SELECT COUNT(*) AS n FROM prefs").get()!.n,
    2,
  );
  untouched.close();
});

Deno.test("prefs use injected schema for reads, writes and notifications without mutating defaults", async () => {
  const root = await fixture(), db = new OtkDb(root, migrations);
  const prefs = new Prefs(db, prefsOptions), changes: unknown[] = [];
  try {
    const insert = db.connection.prepare("INSERT INTO prefs VALUES(?,?,0)");
    insert.run("thinking", '"invalid"');
    insert.run("unknown", "true");
    insert.run("timestamps", "true");
    assertEquals(prefs.get(), { ...defaults, timestamps: true });
    const stop = prefs.listen((value) => changes.push(value));
    assertThrows(
      () => prefs.set("unknown", true),
      Error,
      "Invalid preference key or value",
    );
    assertThrows(() => prefs.set("thinking", false));
    assertEquals(changes, []);
    assertEquals(
      db.connection.prepare("SELECT value FROM prefs WHERE key='thinking'")
        .get()!.value,
      '"invalid"',
    );
    prefs.set("thinking", "show");
    assertEquals(changes, [{ thinking: "show", timestamps: true }]);
    stop();
    prefs.set("timestamps", false);
    assertEquals(changes.length, 1);
    assertEquals(defaults, { thinking: "hide", timestamps: false });
    const snapshot = prefs.get();
    snapshot.thinking = "hide";
    assertEquals(prefs.get().thinking, "show");
    db.connection.prepare("UPDATE prefs SET value=? WHERE key='thinking'").run(
      "not-json",
    );
    assertThrows(() => prefs.get(), SyntaxError);
  } finally {
    db.close();
  }
});
