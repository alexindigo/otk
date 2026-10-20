// SPDX-License-Identifier: LGPL-3.0-only
/** SQLite storage and caller-composed feature migrations, without app policy. */
export { OtkDb } from "./db.ts";
export type { FeatureMigrations, Migration } from "./migrations.ts";
export {
  type ProjectRecord,
  Projects,
  projectsMigrations,
} from "./features/projects.ts";
export { type TaskRecord, Tasks, tasksMigrations } from "./features/tasks.ts";
export { Seen, seenMigrations } from "./features/seen.ts";
export { Finishes, finishesMigrations } from "./features/finishes.ts";
export {
  type PermissionChange,
  permissionMigrations,
  type PermissionRecord,
  PermissionStore,
} from "./features/permissions.ts";
export {
  ProjectTemplates,
  projectTemplatesMigrations,
} from "./features/project-templates.ts";
export { Prefs, prefsMigrations, type PrefsOptions } from "./features/prefs.ts";
export {
  Frecency,
  type FrecencyEntry,
  frecencyMigrations,
  type FrecencyOptions,
} from "./features/frecency.ts";
