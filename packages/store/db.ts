// SPDX-License-Identifier: LGPL-3.0-only
import type { FeatureMigrations } from "./migrations.ts";
import { SqliteDb } from "./sqlite.ts";
/** Disk-backed SQLite connection with caller-composed feature migrations. */
export class OtkDb extends SqliteDb {
  constructor(
    statePath: string,
    migrations: readonly FeatureMigrations[],
    options: { observerError?: (error: unknown) => void } = {},
  ) {
    super(statePath, "otk.db", migrations, { ...options, busyms: 5000 });
  }
}
