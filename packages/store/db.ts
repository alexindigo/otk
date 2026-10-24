// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { transaction } from "./transaction.ts";
import {
  type FeatureMigrations,
  migrate,
  validateMigrations,
} from "./migrations.ts";
/** Disk-backed SQLite connection with caller-composed feature migrations. */
export class OtkDb {
  readonly connection: DatabaseSync;
  readonly observerError: (error: unknown) => void;
  constructor(
    statePath: string,
    migrations: readonly FeatureMigrations[],
    options: { observerError?: (error: unknown) => void } = {},
  ) {
    if (statePath === "") throw new TypeError("State path must not be empty");
    this.observerError = options.observerError ??
      ((error) => console.error("Store observer failed after commit", error));
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
  transaction<T>(run: () => T): T {
    return transaction(this.connection, run);
  }
  close(): void {
    this.connection.close();
  }
}
