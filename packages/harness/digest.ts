// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestDelta, SessionMetadata, SessionUsage } from "@otk/protocol";
export interface DigestPolicy {
  batch: number;
  slicems: number;
  cpu: number;
  memoryreserve: number;
  maxpending: number;
  publishrows: number;
  retryms: number;
  busyms: number;
}
export interface DirtySession {
  sessionID: string;
  revision: number;
  reason: "metadata" | "messages" | "presence" | "attention";
  messages?: string[];
}
export interface DigestPort {
  start(): Promise<void>;
  catalog(
    connection: number,
    signal: AbortSignal,
  ): Promise<
    { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
  >;
  observe(connection: number, dirty: readonly DirtySession[]): void;
  detail(sessionID: string, signal: AbortSignal): Promise<SessionUsage>;
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
  ): Promise<string | undefined>;
  detail(id: string, signal: AbortSignal): Promise<SessionUsage>;
  close(): void | Promise<void>;
}
export interface DigestPublication {
  sessionID: string;
  revision: number;
  delta: DigestDelta;
}
