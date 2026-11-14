// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { OtkDb } from "../db.ts";
import {
  pluginStorageMigrations,
  PluginStore,
} from "../features/plugin-storage.ts";

test("plugin storage survives restart and adversarial identical names never collide", async () => {
  const root = await tempDir("plugin-storage-");
  let db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
  try {
    const store = new PluginStore(db),
      a = store.scope("opencode-v1"),
      b = store.scope("fake' plugin");
    a.set("same-name", "v1 schema and record");
    b.set("same-name", "different schema and record");
    assertEquals(a.get("same-name"), "v1 schema and record");
    assertEquals(b.get("same-name"), "different schema and record");
    assertThrows(() =>
      a.transaction(() => {
        a.set("same-name", "rollback");
        throw new Error("rollback");
      })
    );
    assertEquals(a.get("same-name"), "v1 schema and record");
    a.transaction(() => {
      a.set("prefix/1", "one");
      a.set("prefix/2", "two");
    });
    assertEquals(a.scan({ prefix: "prefix/", limit: 1 }), [{
      key: "prefix/1",
      value: "one",
    }]);
    assertEquals(a.scan({ prefix: "prefix/", after: "prefix/1", limit: 1 }), [{
      key: "prefix/2",
      value: "two",
    }]);
    a.delete("same-name");
    assertEquals(b.get("same-name"), "different schema and record");
    db.close();
    db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
    const reopened = new PluginStore(db);
    assertEquals(reopened.scope("opencode-v1").get("prefix/2"), "two");
    assertEquals(
      reopened.scope("fake' plugin").get("same-name"),
      "different schema and record",
    );
    assertEquals(reopened.scope("opencode-v1").get("same-name"), undefined);
  } finally {
    db.close();
  }
});

test("plugin prefix ranges stay inside valid Unicode scalar boundaries", async () => {
  const root = await tempDir("plugin-storage-unicode-");
  const db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
  try {
    const store = new PluginStore(db);
    for (const prefix of ["x/\ud7fe", "x/\ud7ff", "x/\ud7ff\u{10ffff}"]) {
      const scope = store.scope(prefix);
      const keys = [`${prefix}/a`, `${prefix}/b`];
      for (const key of [...keys, "x/\ue000/unrelated", "x/\ufffd/unrelated"]) {
        scope.set(key, key);
      }
      assertEquals(
        scope.scan({ prefix, limit: 10 }).map((row) => row.key),
        keys,
      );
      assertEquals(scope.scan({ prefix, limit: 1 }).map((row) => row.key), [
        keys[0],
      ]);
      assertEquals(
        scope.scan({ prefix, after: keys[0], limit: 10 }).map((row) => row.key),
        [keys[1]],
      );
      assertEquals(scope.scan({ prefix, after: keys[1], limit: 10 }), []);
    }
  } finally {
    db.close();
  }
});

test("plugin scans seek an indexed namespace and prefix range with bounded continuation rows", async () => {
  const root = await tempDir("plugin-storage-range-");
  const db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
  const prepare = db.connection.prepare;
  const plans: string[] = [];
  try {
    const store = new PluginStore(db),
      scope = store.scope("range"),
      other = store.scope("other");
    scope.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        scope.set(`a/${i}`, "before");
        scope.set(`z/${i}`, "after");
      }
      for (let i = 1; i <= 5; i++) scope.set(`m/${i}`, String(i));
    });
    other.transaction(() => {
      for (let i = 0; i < 2000; i++) other.set(`m/${i}`, "foreign");
    });
    db.connection.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("SELECT key,value FROM plugin_storage")) {
        const all = statement.all.bind(statement);
        statement.all = (...params) => {
          const explain = prepare.call(
            db.connection,
            `EXPLAIN QUERY PLAN ${sql}`,
          );
          const explained: ReturnType<typeof all> = Reflect.apply(
            explain.all,
            explain,
            params,
          );
          const details = explained.map((row) => String(row.detail)).join("\n");
          plans.push(details);
          assertMatch(details, /SEARCH plugin_storage USING PRIMARY KEY/);
          assertMatch(details, /namespace=\?/);
          assertMatch(details, /key>\?/);
          assertMatch(details, /key<\?/);
          assert(!/SCAN |USE TEMP B-TREE/.test(details), details);
          const rows: ReturnType<typeof all> = Reflect.apply(
            all,
            statement,
            params,
          );
          assert(rows.length <= Number(params.at(-1)));
          return rows;
        };
      }
      return statement;
    };
    assertEquals(scope.scan({ prefix: "m/", limit: 2 }).map((row) => row.key), [
      "m/1",
      "m/2",
    ]);
    assertEquals(
      scope.scan({ prefix: "m/", after: "m/2", limit: 2 }).map((row) =>
        row.key
      ),
      ["m/3", "m/4"],
    );
    assertEquals(
      scope.scan({ prefix: "m/", after: "m/4", limit: 2 }).map((row) =>
        row.key
      ),
      ["m/5"],
    );
    assertEquals(
      scope.scan({ prefix: "m/", after: "a/1", limit: 2 }).map((row) =>
        row.key
      ),
      ["m/1", "m/2"],
    );
    assertEquals(scope.scan({ prefix: "m/", after: "z/1", limit: 2 }), []);
    assertEquals(plans.length, 5);
    db.connection.prepare = prepare;
    for (
      const prefix of [
        "",
        "quote'%_",
        "u/\u{1f600}",
        "u/\u{10ffff}",
        "\u{10ffff}",
      ]
    ) {
      const unicode = store.scope(`unicode:${prefix}`);
      unicode.set(`${prefix}1`, "one");
      unicode.set(`${prefix}2`, "two");
      assertEquals(unicode.scan({ prefix, limit: 1 }).map((row) => row.value), [
        "one",
      ]);
      assertEquals(
        unicode.scan({ prefix, after: `${prefix}1`, limit: 2 }).map((row) =>
          row.value
        ),
        ["two"],
      );
    }
  } finally {
    db.connection.prepare = prepare;
    db.close();
  }
});
