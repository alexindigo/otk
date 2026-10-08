// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PREFS, isPreference } from "../../protocol/prefs.ts";
import { OtkDb } from "../../sidecar/db/db.ts";
import { Prefs } from "../../sidecar/db/prefs.ts";
Deno.test("prefs validates the entire whitelist without coercion or inherited keys", () => {
  for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
    assert(isPreference(key, value));
  }
  for (
    const [key, value] of [
      ["constructor", true],
      ["unknown", true],
      ["timestamps", "true"],
      ["thinking", true],
      ["diffStyle", { toString: () => "auto" }],
      ["diffStyle", "stacked"],
    ]
  ) {
    assertEquals(isPreference(key, value), false);
  }
});
Deno.test("otk.db migrates transactionally, uses WAL and preserves prefs on reopen", async () => {
  // Keep this suite's evidence on the project disk, not /tmp.
  const state = new URL("../../.test-state/", import.meta.url);
  await Deno.mkdir(state, { recursive: true });
  const root = await Deno.makeTempDir({
    dir: state.pathname,
    prefix: "prefs-",
  });
  const db = new OtkDb(root), prefs = new Prefs(db);
  assertEquals(
    db.connection.prepare("PRAGMA journal_mode").get()!.journal_mode,
    "wal",
  );
  assertEquals(
    db.connection.prepare("PRAGMA user_version").get()!.user_version,
    1,
  );
  assertEquals(prefs.get(), DEFAULT_PREFS);
  const changes: unknown[] = [],
    stop = prefs.listen((prefs) => changes.push(prefs));
  prefs.set("thinking", "show");
  prefs.set("timestamps", true);
  assertThrows(() => prefs.set("timestamps", 1));
  stop();
  assertEquals(changes.length, 2);
  db.close();
  const reopened = new OtkDb(root);
  assertEquals(new Prefs(reopened).get(), {
    ...DEFAULT_PREFS,
    thinking: "show",
    timestamps: true,
  });
  reopened.close();
  const future = new DatabaseSync(join(root, "otk.db"));
  future.exec("PRAGMA user_version=2");
  future.close();
  assertThrows(() => new OtkDb(root), Error, "Unsupported otk.db schema");
  const untouched = new DatabaseSync(join(root, "otk.db"), { readOnly: true });
  assertEquals(
    untouched.prepare("SELECT COUNT(*) AS n FROM prefs").get()!.n,
    2,
  );
  untouched.close();
});
