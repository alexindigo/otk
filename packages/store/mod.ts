// SPDX-License-Identifier: LGPL-3.0-only
/** SQLite storage and caller-composed feature migrations, without app policy. */
export { OtkDb } from "./db.ts";
export type { FeatureMigrations, Migration } from "./migrations.ts";
export { Prefs, prefsMigrations, type PrefsOptions } from "./features/prefs.ts";
export {
  Frecency,
  type FrecencyEntry,
  frecencyMigrations,
  type FrecencyOptions,
} from "./features/frecency.ts";
