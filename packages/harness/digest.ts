// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DigestDelta,
  SessionMetadata,
  TurnUsageSnapshot,
} from "@otk/protocol";
import type { LatestPrompt, ReplyBoundary } from "@otk/protocol";
import type { ProviderReadPort } from "./provider-reads.ts";
export interface TranscriptMetadata {
  prompt?: LatestPrompt;
  boundaries: ReplyBoundary[];
  cutoffCreated?: number;
}
export interface DigestPolicy {
  idlems: number;
  parallel: number;
  background: boolean;
  batch: number;
  slicems: number;
  cpu: number;
  memoryreserve: number;
  maxpending: number;
  publishrows: number;
  retryms: number;
  busyms: number;
}
/** The configured batch remains the owner; at most eight time-budget subdivisions
 * retain amortized native reads instead of degenerating into one query per row. */
export function digestRowFloor(policy: Pick<DigestPolicy, "batch">): number {
  return Math.max(1, Math.ceil(policy.batch / 8));
}
export interface DirtySession {
  sessionID: string;
  /** Scalar routing seed for an observed identity outside the demand window. */
  metadata?: SessionMetadata;
  revision: number;
  reason:
    | "metadata"
    | "messages"
    | "presence"
    | "attention"
    | "helper"
    | "helper-hint";
  messages?: string[];
}
export interface DigestPort extends ProviderReadPort {
  /** Aggregate native permission shared with serving-isolate finite reads. */
  admission?(signal: AbortSignal): Promise<() => void>;
  /** Optional publication budget for a consumer's live metadata reconciliation. */
  readonly publishrows?: number;
  start(): Promise<void>;
  hydrate?(
    ids: readonly string[],
    signal: AbortSignal,
    retained?: boolean,
  ): Promise<void>;
  projects?(
    connection: number,
    signal: AbortSignal,
    publish?: (projects: readonly import("./types.ts").ProjectSeed[]) => void,
    directory?: string,
  ): Promise<
    { projects: import("./types.ts").ProjectSeed[]; hints?: string[] }
  >;
  catalog(
    connection: number,
    signal: AbortSignal,
  ): Promise<
    { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
  >;
  observe(connection: number, dirty: readonly DirtySession[]): void;
  deleted(
    connection: number,
    sessionID: string,
    revision: number,
    metadata?: SessionMetadata,
  ): Promise<void>;
  detail(
    sessionID: string,
    turnID: string,
    signal: AbortSignal,
  ): Promise<TurnUsageSnapshot>;
  transcriptMetadata(
    sessionID: string,
    turns: readonly string[],
    signal: AbortSignal,
    cutoff?: string,
  ): Promise<TranscriptMetadata>;
  deleteIntent(
    sessionID: string,
    intent: string,
    phase: "begin" | "confirmed" | "failed",
    connection: number,
  ): Promise<void>;
  scope(owner: string, value: { directory?: string; sessions: string[] }): void;
  release(owner: string): void;
  stop(): Promise<void>;
}
export type DigestPriority =
  | "interactive"
  | "attention"
  | "visible"
  | "background";
export interface DigestIdentity {
  projection?: "helper";
  interruptible?: boolean;
  provider: string;
  sessionID: string;
  updated: number;
  directory?: string;
}
export interface DigestJob extends DigestIdentity {
  cursor?: string;
  revision: number;
  /** Undefined keys means full reconciliation, never no work. */
  messages?: string[];
}
export interface DigestBudget {
  rows: number;
  until: number;
}
/** A bounded executing turn. Readiness waits release it and re-admit at priority. */
export interface DigestExecution {
  readonly priority: DigestPriority;
  readonly workms: number;
  wait<T>(readiness: PromiseLike<T>, kind?: "readiness" | "io"): Promise<T>;
  /** Cleanup joins real I/O settlement before releasing an acquired permission. */
  join<T>(readiness: PromiseLike<T>): Promise<T>;
  /** Account bounded CPU work performed off-thread, excluding readiness waits. */
  charge(elapsedMs: number): void;
}
export interface DigestSink {
  identity: string;
  catalog(
    signal: AbortSignal,
  ): Promise<
    { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
  >;
  step(
    job: DigestJob,
    budget: DigestBudget,
    signal: AbortSignal,
    execution: DigestExecution,
  ): Promise<string | undefined>;
  detail(
    id: string,
    turnID: string,
    signal: AbortSignal,
  ): Promise<TurnUsageSnapshot>;
  close(): void | Promise<void>;
}
export interface DigestPublication {
  sessionID: string;
  revision: number;
  delta: DigestDelta;
  /** A newly retained identity must be seeded before its first digest delta. */
  metadata?: SessionMetadata;
}
