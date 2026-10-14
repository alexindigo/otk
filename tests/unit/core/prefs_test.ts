// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { DEFAULT_PREFS } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import { frecencyMigrations, OtkDb, Prefs, prefsMigrations } from "@otk/store";
import { prefsOptions } from "../../../core/mod.ts";
import { fixture } from "./support.ts";

Deno.test("app storage retains every preference default, validator and params error", async () => {
  const root = await fixture(),
    migrations = [...prefsMigrations, ...frecencyMigrations];
  const db = new OtkDb(root, migrations), prefs = new Prefs(db, prefsOptions);
  const expected = {
    ...DEFAULT_PREFS,
    thinking: "show" as const,
    diffStyle: "unified" as const,
  };
  try {
    assertEquals(prefs.get(), DEFAULT_PREFS);
    for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
      const error = assertThrows(
        () => prefs.set(key, null),
        HarnessError,
        "Invalid preference key or value",
      );
      assertEquals(error.code, "params");
      if (typeof value === "boolean") {
        prefs.set(key, !value);
        Object.assign(expected, { [key]: !value });
      }
    }
    prefs.set("thinking", "show");
    prefs.set("diffStyle", "unified");
    for (const key of ["output_times", "outputTimes", "unknown", "__proto__"]) {
      assertThrows(() => prefs.set(key, true), HarnessError);
    }
    assertEquals(prefs.get(), expected);
  } finally {
    db.close();
  }
  const next = new OtkDb(root, migrations);
  try {
    assertEquals(new Prefs(next, prefsOptions).get(), expected);
  } finally {
    next.close();
  }
});
