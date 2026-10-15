// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  type FeatureMigrations,
  migrate,
  validateMigrations,
} from "./migrations.ts";
/** Disk-backed SQLite connection with caller-composed feature migrations. */
export class OtkDb {
  readonly connection: DatabaseSync;
  constructor(statePath: string, migrations: readonly FeatureMigrations[]) {
    validateMigrations(migrations);
    Deno.mkdirSync(statePath, { recursive: true, mode: 0o700 });
    const db = this.connection = new DatabaseSync(join(statePath, "otk.db"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
      migrate(db, migrations);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.connection.close();
  }
}
