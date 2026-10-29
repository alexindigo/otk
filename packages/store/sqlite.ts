// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { transaction } from "./transaction.ts";
import {
  type FeatureMigrations,
  migrate,
  validateMigrations,
} from "./migrations.ts";

export interface SqliteOptions {
  /** Zero is fail-fast: an external cooperative owner waits/retries lock readiness. */
  busyms: number;
  observerError?: (error: unknown) => void;
}
/** Connection mechanics only. Feature composition belongs to the caller. */
export class SqliteDb {
  readonly connection: DatabaseSync;
  readonly observerError: (error: unknown) => void;
  constructor(
    statePath: string,
    filename: string,
    migrations: readonly FeatureMigrations[],
    options: SqliteOptions,
  ) {
    if (statePath === "") throw new TypeError("State path must not be empty");
    if (!/^[a-zA-Z0-9_-]+\.db$/.test(filename)) {
      throw new TypeError("Invalid database filename");
    }
    if (!Number.isSafeInteger(options.busyms) || options.busyms < 0) {
      throw new TypeError("Invalid SQLite busy timeout");
    }
    validateMigrations(migrations);
    this.observerError = options.observerError ??
      ((error) => console.error("Store observer failed after commit", error));
    Deno.mkdirSync(statePath, { recursive: true, mode: 0o700 });
    const path = join(statePath, filename);
    const db = this.connection = new DatabaseSync(path);
    try {
      Deno.chmodSync(path, 0o600);
      // Install the lock wait before WAL selection (concurrent first open).
      db.exec(
        `PRAGMA busy_timeout=${options.busyms}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON`,
      );
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
