// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { OtkDb } from "@otk/store";
import { opencodeV1SessionID } from "@otk/harness-opencode-v1";
import { createSessionReferenceUpgrade } from "../../core/features/session-ids.ts";
import {
  beta1State,
  beta2Migrations,
  upgradedManifest,
} from "../support/beta1-state.ts";
import { RemainingMeasurements } from "../support/remaining-measurements.ts";
import { tempDir, test } from "../support/resources.ts";

test("genuine beta.1 schema upgrades preserve every user record and restart idempotently", async () => {
  const root = await tempDir("beta2-upgrade-");
  const report = new RemainingMeasurements(root, "beta1-upgrade");
  const { before, unchanged, snapshot } = await beta1State(root);
  let db = new OtkDb(root, beta2Migrations, { busyms: 5000 });
  try {
    createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {
      now: () => 42,
    })(db);
    assertEquals(snapshot(db), upgradedManifest(before));
    for (const table of unchanged) {
      assertEquals(snapshot(db)[table], before[table], table);
    }
    assertEquals(
      db.connection.prepare("SELECT count(*) AS n FROM permission_activity")
        .get()!.n,
      100,
    );
    assertEquals(
      db.connection.prepare("SELECT count(*) AS n FROM request_receipts").get()!
        .n,
      0,
    );
    assertEquals(
      db.connection.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='tasks_directory_position'",
      ).get()!.n,
      1,
    );
    const after = snapshot(db);
    db.close();
    db = new OtkDb(root, beta2Migrations, { busyms: 5000 });
    createSessionReferenceUpgrade(opencodeV1SessionID.legacy)(db);
    assertEquals(snapshot(db), after);
    await report.write({
      activityRows: 100,
      users: 2,
      unchangedTables: unchanged,
      referenceTables: Object.keys(after),
      restartIdentical: true,
    });
  } finally {
    db.close();
  }
});

for (
  const boundary of [
    "task_sessions",
    "session_seen",
    "session_finishes",
    "permission_auto",
    "permission_activity",
    "permission_activity_family",
    "prefs",
    "marker",
  ]
) {
  test(`beta.1 upgrade rolls back at ${boundary} and preserves the retryable original`, async () => {
    const root = await tempDir("beta2-fault-");
    const { before, snapshot } = await beta1State(root);
    let db = new OtkDb(root, beta2Migrations, { busyms: 5000 });
    try {
      assertThrows(
        () =>
          createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {
            checkpoint(table) {
              if (table === boundary) throw new Error("owned upgrade fault");
            },
          })(db),
        Error,
        "owned upgrade fault",
      );
      assertEquals(snapshot(db), before);
      db.close();
      db = new OtkDb(root, beta2Migrations, { busyms: 5000 });
      createSessionReferenceUpgrade(opencodeV1SessionID.legacy)(db);
      assertEquals(snapshot(db), upgradedManifest(before));
    } finally {
      db.close();
    }
  });
}

for (const feature of ["tasks", "session-reference-upgrade", "requests"]) {
  for (const boundary of ["before", "after"]) {
    test(`beta.1 ${feature} schema failure ${boundary} SQL is recoverable without losing user state`, async () => {
      const root = await tempDir("beta2-schema-fault-");
      const { before, snapshot } = await beta1State(root);
      const fault = beta2Migrations.map((value) =>
        value.feature !== feature ? value : {
          ...value,
          migrations: value.migrations.map((migration, n) => {
            if (n !== value.migrations.length - 1) return migration;
            const sql = migration.sql instanceof URL
              ? Deno.readTextFileSync(migration.sql)
              : migration.sql;
            const failure = "SELECT * FROM c9_injected_missing_table;";
            return {
              ...migration,
              sql: boundary === "before" ? failure + sql : sql + failure,
            };
          }),
        }
      );
      assertThrows(
        () => new OtkDb(root, fault, { busyms: 5000 }),
        Error,
        "c9_injected_missing_table",
      );
      let db = new OtkDb(root, [], { busyms: 5000 });
      try {
        assertEquals(snapshot(db), before);
        db.close();
        db = new OtkDb(root, beta2Migrations, { busyms: 5000 });
        createSessionReferenceUpgrade(opencodeV1SessionID.legacy)(db);
        assertEquals(snapshot(db), upgradedManifest(before));
      } finally {
        db.close();
      }
    });
  }
}
