// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DigestDb,
  OtkDb,
  pluginStorageMigrations,
  PluginStore,
  StorageAvailability,
  StorageFailure,
  storageProblem,
} from "@otk/store";
import { test } from "../../../tests/support/resources.ts";
import { fixture } from "./support.ts";

test("same-path connections recover only their own failures and close only their own probes", async () => {
  const availability = new StorageAvailability(), root = await fixture();
  const connections = new Set<OtkDb>();
  const open = () => {
    const db = new OtkDb(root, [], { busyms: 0, availability });
    connections.add(db);
    return db;
  };
  const close = (db: OtkDb) => {
    connections.delete(db);
    db.close();
  };
  const first = open(), second = open(), unrelated = open();
  try {
    const exhaust = (db: OtkDb) => {
      const pages =
        db.connection.prepare("PRAGMA page_count").get()!.page_count;
      db.connection.exec(`PRAGMA max_page_count=${pages}`);
      assertThrows(() => db.probe(), StorageFailure);
    };
    exhaust(first);
    exhaust(second);
    close(unrelated);
    assertEquals(availability.status(), {
      degraded: true,
      problem: "full",
      gap: 1,
    });
    first.connection.exec("PRAGMA max_page_count=1073741823");
    first.probe();
    assertEquals(availability.status().degraded, true);
    close(first);
    second.connection.exec("PRAGMA max_page_count=1073741823");
    availability.probe();
    assertEquals(availability.status(), { degraded: false, gap: 1 });
  } finally {
    for (const db of connections) close(db);
  }
});

test("SQLITE_FULL preserves the primary cause after automatic rollback and publishes no commit", async () => {
  const db = new OtkDb(await fixture(), [pluginStorageMigrations], {
    busyms: 0,
  });
  try {
    const plugin = new PluginStore(db).scope("storage-full");
    plugin.set("retained", "before");
    const pages = Number(
      db.connection.prepare("PRAGMA page_count").get()!.page_count,
    );
    db.connection.exec(`PRAGMA max_page_count=${pages}`);
    let published = false;
    const error = assertThrows(() =>
      db.write((tx) => {
        db.afterCommit(tx, () => {
          published = true;
        });
        db.connection.prepare("INSERT INTO plugin_storage VALUES(?,?,?)")
          .run("storage-full", "lost", "x".repeat(1024 * 1024));
      })
    );
    assert(
      !(error instanceof AggregateError),
      "automatic rollback must not replace the primary storage failure",
    );
    assertEquals(published, false);
    assertEquals(plugin.get("retained"), "before");
    assertEquals(plugin.get("lost"), undefined);
    assertEquals(db.connection.isTransaction, false);
    assertEquals(storageProblem(error), "full");
    assert(error instanceof StorageFailure);
    assert(error.database.endsWith("otk.db"));
    assertEquals(error.operation, "statement.run");
    assertEquals(storageProblem(error.cause), "full");
    assertThrows(() => db.probe());
    assertEquals(db.availability.status().degraded, true);
    db.connection.exec("PRAGMA max_page_count=1073741823");
    db.probe();
    plugin.set("recovered", "after");
    assertEquals(plugin.get("recovered"), "after");
  } finally {
    db.close();
  }
});

test("storage availability clears only after every affected connection commits a real probe", async () => {
  const owner = new StorageAvailability();
  const statuses: boolean[] = [];
  const stop = owner.listen((status) => statuses.push(status.degraded));
  const root = await fixture();
  const metadata = new OtkDb(root, [pluginStorageMigrations], {
    busyms: 0,
    availability: owner,
  });
  const digest = new DigestDb(root, [], { busyms: 0, availability: owner });
  try {
    for (const db of [metadata, digest]) {
      db.connection.exec("CREATE TABLE full_test(value BLOB)");
      const pages = Number(
        db.connection.prepare("PRAGMA page_count").get()!.page_count,
      );
      db.connection.exec(`PRAGMA max_page_count=${pages}`);
      assertThrows(() =>
        db.transaction(() =>
          db.connection.prepare("INSERT INTO full_test VALUES(?)").run(
            new Uint8Array(1024 * 1024),
          )
        )
      );
    }
    assertEquals(owner.status().degraded, true);
    assertEquals(owner.status().gap, 1);
    for (const db of [metadata, digest]) {
      db.connection.exec("PRAGMA max_page_count=1073741823");
    }
    // Failed probes and ordinary SELECTs never establish recovery.
    let blocked = true;
    const connection = owner.register("probe-fault", () => {
      if (blocked) {
        throw new StorageFailure("full", "probe-fault", "probe", undefined);
      }
    });
    connection.failed(
      new StorageFailure("full", "probe-fault", "write", undefined),
    );
    metadata.connection.prepare("SELECT 1").get();
    owner.probe();
    assertEquals(owner.status().degraded, true);
    blocked = false;
    owner.probe();
    assertEquals(owner.status(), { degraded: false, gap: 1 });
    assertEquals(statuses.filter((degraded) => !degraded).length, 1);
    connection.close();
    metadata.connection.exec("PRAGMA max_page_count=1073741823");
    new PluginStore(metadata).scope("recovery").set("saved", "after full");
    assertEquals(
      new PluginStore(metadata).scope("recovery").get("saved"),
      "after full",
    );
    assertEquals(
      metadata.connection.prepare("PRAGMA mmap_size").get()!.mmap_size,
      0,
    );
    assertEquals(
      digest.connection.prepare("PRAGMA journal_mode").get()!.journal_mode,
      "wal",
    );
  } finally {
    stop();
    metadata.close();
    digest.close();
  }
});

test("storage classification covers native extended SQLite and filesystem codes, not arbitrary prose", () => {
  assertEquals(storageProblem({ errcode: 13 }), "full");
  assertEquals(storageProblem({ code: "ENOSPC" }), "full");
  assertEquals(storageProblem({ code: "EDQUOT" }), "full");
  assertEquals(storageProblem({ errcode: 778 }), "io");
  assertEquals(storageProblem({ code: "EIO" }), "io");
  assertEquals(
    storageProblem(new Error("database or disk is full")),
    undefined,
  );
  assertEquals(
    storageProblem({ errcode: 5, message: "database is locked" }),
    undefined,
  );
});
