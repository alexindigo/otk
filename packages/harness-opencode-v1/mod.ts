// SPDX-License-Identifier: LGPL-3.0-only
/** Stock opencode 1.x harness, native projections and mapping utilities. */
export { OpencodeV1Adapter } from "./adapter.ts";
export {
  harnessDb,
  type OpencodeV1AdapterConfig,
  type OpencodeV1Config,
} from "./config.ts";
export { opencodeV1SessionID } from "./ids.ts";
export { opencodeV1DigestMigrations } from "./digest-migrations.ts";
export { OpencodeV1DigestSink } from "./digest.ts";
export type {
  DigestCheckpoint,
  DigestSnapshot,
  OpencodeV1DigestReadiness,
  OpencodeV1DigestStorage,
} from "./digest.ts";
export { DigestNativeDb } from "./digest-db.ts";
export type { DigestHeader } from "./digest-db.ts";
export { History } from "./history.ts";
export { BootstrapDb } from "./db.ts";
export {
  Client,
  HttpFailure,
  NativeRequestFailure,
  type NativeRequestOptions,
} from "./client.ts";
export type { NativeLaunch } from "./shell.ts";
export { consumeEvents } from "./events.ts";
export { envelopeType } from "./envelope.ts";
export { Backoff, Watchdog } from "./watchdog.ts";
export {
  mapDiffs,
  mapIndex,
  mapMessage,
  mapPart,
  mapPermission,
  mapSession,
} from "./map.ts";
export { mapTool } from "./map-tools.ts";
export { mapPromptParts } from "./prompt.ts";
export { mapQuestion } from "./questions.ts";
export { TaskProgress } from "./tasks.ts";
export type * from "./types.ts";
