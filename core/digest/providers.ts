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

/** Open selected contribution map; future providers add their config here. */
export interface DigestProviderConfigs {
  "opencode-v1": OpencodeV1Config;
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
  const contributions = new Map([["opencode-v1", {
    migrations: opencodeV1DigestMigrations,
    reads: opencodeV1ReadCodecs as ProviderReadCodecs,
    create: (
      policy: DigestPolicy,
      storage: OpencodeV1DigestStorage,
      readiness: OpencodeV1DigestReadiness,
      observe?: ConstructorParameters<typeof DigestNativeDb>[1],
    ): WorkerDigestSink =>
      new OpencodeV1DigestSink(
        native,
        policy,
        storage,
        fetch,
        (file) => new DigestNativeDb(file, observe),
        readiness,
      ),
  }]]);
  const selected = contributions.get(provider);
  if (!selected) throw new Error("Unknown digest provider");
  return selected;
}
