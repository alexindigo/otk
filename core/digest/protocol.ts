// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestPolicy, DirtySession } from "@otk/harness";
import type {
  DigestDelta,
  SessionMetadata,
  TurnUsageSnapshot,
} from "@otk/protocol";
import type { OpencodeV1Config } from "@otk/harness-opencode-v1";
import type { TranscriptMetadata } from "@otk/harness";
import type { ProviderReadKinds, ProviderReadOptions } from "@otk/harness";
import type { PublicFailure } from "@otk/protocol";
export type ProviderReadCommand = {
  [K in keyof ProviderReadKinds]: {
    t: "read";
    owner: string;
    kind: K;
    input: ProviderReadKinds[K]["input"];
    priority: ProviderReadOptions["priority"];
  };
}[keyof ProviderReadKinds];
export type ProviderReadResult = {
  [K in keyof ProviderReadKinds]: {
    t: "read.result";
    kind: K;
    part: number;
    last: boolean;
    value: ProviderReadKinds[K]["chunk"];
  };
}[keyof ProviderReadKinds];
export interface DigestPressure {
  queued: number;
  active: number;
  sliceMs: number;
  nativeReads?: Record<string, number>;
}
export interface DigestWorkerValue {
  sessionID: string;
  revision: number;
  part: number;
  last: boolean;
  delta: DigestDelta;
}
export type ToWorker =
  & { run: string; id: number }
  & (
    | {
      t: "start";
      provider: string;
      statePath: string;
      native: OpencodeV1Config;
      policy: DigestPolicy;
      since: number;
      connection?: number;
      diagnostics?: boolean;
    }
    | { t: "catalog"; connection: number }
    | ProviderReadCommand
    | { t: "read.cancel" }
    | { t: "dirty"; connection: number; sessions: DirtySession[] }
    | {
      t: "deleted";
      connection: number;
      sessions: {
        sessionID: string;
        revision: number;
        metadata?: SessionMetadata;
      }[];
    }
    | { t: "scope"; owner: string; directory?: string; sessions: string[] }
    | { t: "interactive"; owner: string; active: boolean }
    | { t: "detail"; sessionID: string; turnID: string }
    | { t: "transcript"; sessionID: string; turns: string[]; cutoff?: string }
    | {
      t: "deleteIntent";
      sessionID: string;
      intent: string;
      phase: "begin" | "confirmed" | "failed";
      connection: number;
    }
    | { t: "credit"; publications: number }
    | { t: "cancel"; request: number }
    | { t: "stop" }
  );
export type FromWorker =
  & { run: string; id: number }
  & (
    | { t: "accepted" }
    | ProviderReadResult
    | {
      t: "read.failure";
      outcome: "rejected" | "unavailable";
      failure: PublicFailure;
    }
    | { t: "transcript"; sessionID: string; metadata: TranscriptMetadata }
    | {
      t: "catalog";
      connection: number;
      entries: SessionMetadata[];
      part: number;
      last: boolean;
      authoritative: boolean;
      hints?: string[];
    }
    | ({ t: "digest" } & DigestWorkerValue)
    | { t: "digests"; values: DigestWorkerValue[] }
    | { t: "progress"; values: import("@otk/protocol").ProgressFacts[] }
    | {
      t: "detail";
      sessionID: string;
      part: number;
      last: boolean;
      turnID: string;
      revision: number;
      summary?: TurnUsageSnapshot["summary"];
      calls: TurnUsageSnapshot["calls"];
    }
    | ({ t: "pressure" } & DigestPressure)
    | {
      t: "error";
      scope: "session" | "worker";
      sessionID?: string;
      message: string;
    }
    | { t: "stopped" }
  );
