// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";

/** IDs are the existing contiguous PRAGMA user_version sequence, starting at 1. */
export interface Migration {
  readonly id: number;
  /** SQL text or a packaged SQL file. Read only when the migration is pending. */
  readonly sql: string | URL;
}

export function validateMigrations(migrations: readonly Migration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.id !== index + 1) {
      throw new Error(
        `Expected migration ${index + 1}, received ${migration.id}`,
      );
    }
  }
}

export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[],
): void {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version > migrations.length) {
    throw new Error(`Unsupported otk.db schema ${version}`);
  }
  for (const migration of migrations.slice(version)) {
    const sql = migration.sql instanceof URL
      ? Deno.readTextFileSync(migration.sql)
      : migration.sql;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version=${migration.id}; COMMIT`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
