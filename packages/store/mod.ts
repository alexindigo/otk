// SPDX-License-Identifier: LGPL-3.0-only
/** SQLite storage and caller-composed feature migrations, without app policy. */
export { OtkDb, type StoreWrite } from "./db.ts";
export {
  pluginStorageMigrations,
  PluginStore,
} from "./features/plugin-storage.ts";
export {
  type KeyPolicy,
  MAX_METADATA_KEY,
  validateKey,
} from "./features/metadata.ts";
export {
  type ReceiptKey,
  type RequestRecord,
  Requests,
  requestsMigrations,
} from "./features/requests.ts";
export { digestMigrations } from "./features/digest.ts";
export { DigestDb, DigestStore, digestTurnCursor } from "./digest.ts";
export type {
  DigestBookkeepingRecord,
  DigestCommit,
  DigestHelperRecord,
  DigestPersistence,
  DigestSessionRecord,
  DigestTurnRecord,
  DigestUsageRecord,
} from "./digest.ts";
export { sessionReferenceMigrations } from "./features/session-references.ts";
export {
  type CheckoutRecord,
  Checkouts,
  checkoutsMigrations,
} from "./features/checkouts.ts";
export type { FeatureMigrations, Migration } from "./migrations.ts";
export {
  type ProjectChange,
  type ProjectRecord,
  Projects,
  projectsMigrations,
} from "./features/projects.ts";
export {
  type TaskChange,
  type TaskRecord,
  Tasks,
  tasksMigrations,
} from "./features/tasks.ts";
export { Seen, type SeenChange, seenMigrations } from "./features/seen.ts";
export {
  type FinishChange,
  Finishes,
  finishesMigrations,
} from "./features/finishes.ts";
export {
  type PermissionChange,
  permissionMigrations,
  type PermissionRecord,
  PermissionStore,
} from "./features/permissions.ts";
export {
  ProjectTemplates,
  projectTemplatesMigrations,
  type TemplateChange,
} from "./features/project-templates.ts";
export { Prefs, prefsMigrations, type PrefsOptions } from "./features/prefs.ts";
export {
  Frecency,
  FRECENCY_RETENTION,
  type FrecencyEntry,
  frecencyMigrations,
  type FrecencyOptions,
} from "./features/frecency.ts";
