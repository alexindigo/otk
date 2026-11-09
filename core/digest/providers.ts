// SPDX-License-Identifier: LGPL-3.0-only
/** Application composition for native providers. Scheduler/bridge know no codec. */
import type {
  DigestPolicy,
  DigestSink,
  ProviderReadCodecs,
} from "@otk/harness";
import {
  DigestNativeDb,
  type OpencodeV1Config,
  opencodeV1DigestMigrations,
  type OpencodeV1DigestReadiness,
  OpencodeV1DigestSink,
  type OpencodeV1DigestStorage,
  opencodeV1ReadCodecs,
} from "@otk/harness-opencode-v1";
import {
  opencodeV2DigestMigrations,
  OpencodeV2DigestSink,
  opencodeV2ReadCodecs,
  type V2NativeConfig,
} from "@otk/harness-opencode-v2-server";

/** Open selected contribution map; future providers add their config here. */
export interface DigestProviderConfigs {
  "opencode-v1": OpencodeV1Config;
  "opencode-v2-server": V2NativeConfig;
}
export type DigestNativeConfig =
  DigestProviderConfigs[keyof DigestProviderConfigs];
export type WorkerDigestSink =
  & DigestSink
  & Pick<
    OpencodeV1DigestSink,
    | "readers"
    | "connection"
    | "projects"
    | "hydrate"
    | "discover"
    | "pending"
    | "invalidate"
    | "invalidateHelper"
    | "requestHelper"
    | "discoveryProject"
    | "deleted"
    | "deleteIntent"
    | "transcriptMetadata"
  >;
export function selectDigestProvider(
  provider: string,
  native: DigestNativeConfig,
) {
  const contributions = new Map<string, {
    migrations: typeof opencodeV1DigestMigrations;
    reads: ProviderReadCodecs;
    create(
      policy: DigestPolicy,
      storage: OpencodeV1DigestStorage,
      readiness: OpencodeV1DigestReadiness,
      observe?: ConstructorParameters<typeof DigestNativeDb>[1],
    ): WorkerDigestSink;
  }>([["opencode-v1", {
    migrations: opencodeV1DigestMigrations,
    reads: opencodeV1ReadCodecs as ProviderReadCodecs,
    create: (
      policy: DigestPolicy,
      storage: OpencodeV1DigestStorage,
      readiness: OpencodeV1DigestReadiness,
      observe?: ConstructorParameters<typeof DigestNativeDb>[1],
    ): WorkerDigestSink =>
      new OpencodeV1DigestSink(
        native as OpencodeV1Config,
        policy,
        storage,
        fetch,
        (file) => new DigestNativeDb(file, observe),
        readiness,
      ),
  }], ["opencode-v2-server", {
    migrations: opencodeV2DigestMigrations,
    reads: opencodeV2ReadCodecs,
    create: (policy, storage, readiness, observe) =>
      new OpencodeV2DigestSink(
        native as V2NativeConfig,
        policy,
        storage,
        readiness,
        observe,
      ),
  }]]);
  const selected = contributions.get(provider);
  if (!selected) throw new Error("Unknown digest provider");
  return selected;
}
