// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import { legacyMigrations } from "./legacy.ts";
import { transaction } from "./transaction.ts";

/** A version within one feature's append-only upgrade list, starting at 1. */
export interface Migration {
  readonly version: number;
  /** SQL text or a packaged SQL file. Read only when the migration is pending. */
  readonly sql: string | URL;
}

/** Stable feature identity and its independently numbered schema upgrades. */
export interface FeatureMigrations {
  readonly feature: string;
  readonly migrations: readonly Migration[];
}

export function validateMigrations(
  features: readonly FeatureMigrations[],
): void {
  const names = new Set<string>();
  for (const { feature, migrations } of features) {
    if (!/^[a-zA-Z0-9][\w.:-]{0,119}$/.test(feature) || names.has(feature)) {
      throw new Error(`Invalid or duplicate migration feature: ${feature}`);
    }
    names.add(feature);
    for (const [index, migration] of migrations.entries()) {
      if (migration.version !== index + 1) {
        throw new Error(
          `Expected ${feature} migration ${
            index + 1
          }, received ${migration.version}`,
        );
      }
    }
  }
}

function applied(db: DatabaseSync, feature: FeatureMigrations): number {
  const rows = db.prepare(
    "SELECT version FROM otk_migrations WHERE feature=? ORDER BY version",
  ).all(feature.feature);
  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1 || index >= feature.migrations.length) {
      throw new Error(
        `Unsupported otk.db feature ${feature.feature} version ${row.version}: expected contiguous versions 1..${feature.migrations.length}`,
      );
    }
  }
  return rows.length;
}

export function migrate(
  db: DatabaseSync,
  features: readonly FeatureMigrations[],
): void {
  transaction(db, () => {
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='otk_migrations'",
      ).get()
    ) {
      const legacy = legacyMigrations(db);
      db.exec(`CREATE TABLE otk_migrations (
        feature TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        PRIMARY KEY (feature, version)
      )`);
      const insert = db.prepare(
        "INSERT INTO otk_migrations(feature,version) VALUES(?,?)",
      );
      for (const row of legacy) insert.run(row.feature, row.version);
    }
    // Reject every selected feature's unsupported state before applying any SQL.
    for (const feature of features) applied(db, feature);
  });
  for (const feature of features) {
    transaction(db, () => {
      // Re-read under the write lock: another connection may have upgraded it.
      const version = applied(db, feature);
      const insert = db.prepare(
        "INSERT INTO otk_migrations(feature,version) VALUES(?,?)",
      );
      for (const migration of feature.migrations.slice(version)) {
        const sql = migration.sql instanceof URL
          ? Deno.readTextFileSync(migration.sql)
          : migration.sql;
        db.exec(sql);
        insert.run(feature.feature, migration.version);
      }
    });
  }
}
