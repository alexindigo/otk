// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { Frecency, frecencyMigrations, OtkDb } from "../mod.ts";
Deno.test("global frecency pruning publishes removals in their original directory and rollback is silent", async () => {
  const root = await Deno.makeTempDir();
  const db = new OtkDb(root, [frecencyMigrations], { busyms: 5000 });
  const store = new Frecency(db, {
    maxLength: 4096,
    invalid: () => new Error("invalid path"),
  });
  const changes: unknown[] = [];
  const stop = store.listen((value) => changes.push(value));
  try {
    for (let i = 0; i < 1000; i++) {
      db.connection.prepare(
        "INSERT INTO frecency(directory,path,score,last) VALUES(?,?,?,?)",
      ).run("/old", `/old/${i}`, 1, i);
    }
    store.bump("/new", "selected");
    assertEquals(changes.length, 2);
    assertEquals(changes[1], {
      directory: "/old",
      upsert: [],
      remove: ["/old/0"],
    });
    changes.length = 0;
    assertThrows(() =>
      db.write((tx) => {
        store.bump("/new", "rolled-back", tx);
        throw new Error("rollback");
      })
    );
    assertEquals(changes, []);
    assertEquals(
      store.list("/new").some((entry) => entry.path.endsWith("rolled-back")),
      false,
    );
  } finally {
    stop();
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});
