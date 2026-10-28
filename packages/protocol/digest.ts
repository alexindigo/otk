// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "./content.ts";
export interface ReportedTokens {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache: { read: number | null; write: number | null };
}
export interface UsageSummary {
  calls: number;
  cost: number | null;
  tokens: ReportedTokens;
  time?: { start: number; end?: number };
  contextPeak: number | null;
}
export interface SessionDigest {
  state: "digesting" | "ready" | "unavailable";
  revision: number;
  digestedAt?: number;
  nativeUpdatedAt?: number;
  messageCount?: number;
  total?: UsageSummary;
  turns: Record<string, UsageSummary>;
  last?: { agent?: string; model?: ModelRef; context?: ReportedTokens };
}
export interface Tombstone {
  at: number;
  how: "otk" | "provider";
}
export interface DigestDelta {
  summary: Omit<SessionDigest, "turns">;
  turns: { upsert: Record<string, UsageSummary>; remove: string[] };
  deleted: Tombstone | null;
}
