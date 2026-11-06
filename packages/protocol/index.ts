// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionErrorState } from "./errors.ts";
import type { DigestDelta, SessionDigest, Tombstone } from "./digest.ts";
export interface SessionMetadata {
  id: string;
  parentID?: string;
  directory: string;
  projectID: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  archived: boolean;
  status: "idle" | "busy" | "retry";
  /** Missing retains the standalone harness's authoritative metadata contract. */
  activityAuthority?: "current" | "stale" | "unknown";
  retry?: { attempt: number; message: string; next: number };
  attention: {
    permissions: number;
    questions: number;
    childPermissions: number;
    childQuestions: number;
    error?: string;
    errorState?: SessionErrorState;
  };
}
export interface IndexEntry extends SessionMetadata {
  digest: SessionDigest;
  deleted?: Tombstone;
}
/** Activity/topology metadata, without a digest or retained turn history. */
export type IndexMetadata = Omit<IndexEntry, "digest">;
export interface DigestIndexDelta extends DigestDelta {
  id: string;
  revision: number;
}
export type IndexOp = { op: "upsert"; entry: IndexEntry } | {
  op: "remove";
  id: string;
} | ({ op: "digest" } & DigestIndexDelta);
