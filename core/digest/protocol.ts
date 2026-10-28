// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestPolicy, DirtySession } from "@otk/harness";
import type { DigestDelta, SessionMetadata, SessionUsage } from "@otk/protocol";
import type { OpencodeV1Config } from "@otk/harness-opencode-v1";
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
    }
    | { t: "catalog"; connection: number }
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
    | { t: "detail"; sessionID: string }
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
    | {
      t: "catalog";
      connection: number;
      entries: SessionMetadata[];
      part: number;
      last: boolean;
      authoritative: boolean;
      hints?: string[];
    }
    | {
      t: "digest";
      sessionID: string;
      revision: number;
      part: number;
      last: boolean;
      delta: DigestDelta;
    }
    | {
      t: "detail";
      sessionID: string;
      part: number;
      last: boolean;
      total?: SessionUsage["total"];
      turns: SessionUsage["turns"];
      messages: SessionUsage["messages"];
    }
    | { t: "pressure"; queued: number; active: number; sliceMs: number }
    | {
      t: "error";
      scope: "session" | "worker";
      sessionID?: string;
      message: string;
    }
    | { t: "stopped" }
  );
