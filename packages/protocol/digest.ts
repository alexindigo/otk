// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "./content.ts";
import type { HelperSummary } from "./transcript.ts";
/** Knowledge belongs to the derived unit, independently of refresh activity. */
export type Derived<T> =
  | { state: "pending" }
  | { state: "unavailable" }
  | {
    state: "known";
    value: T;
    final: boolean;
    witness: { source: string; revision: number };
  };
export function knownDerived<T>(
  value: T,
  source: string,
  revision: number,
  final = false,
  previous?: Derived<T>,
): Derived<T> {
  if (previous?.state === "known") {
    if (
      previous.witness.source === source && previous.final === final &&
      JSON.stringify(previous.value) === JSON.stringify(value)
    ) return previous;
    revision = previous.witness.revision + 1;
  }
  return { state: "known", value, final, witness: { source, revision } };
}
export function derivedValue<T>(result: Derived<T> | undefined): T | undefined {
  return result?.state === "known" ? result.value : undefined;
}
/** Decode a result without teaching transport about the value's domain. */
export function decodeDerived<T>(
  input: unknown,
  decode: (value: unknown) => T,
): Derived<T> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid derived result");
  }
  const result = input as Record<string, unknown>;
  if (result.state === "pending" || result.state === "unavailable") {
    if (Object.keys(result).length !== 1) {
      throw new TypeError("Invalid empty derived result");
    }
    return { state: result.state };
  }
  const witness = result.witness as Record<string, unknown> | undefined;
  if (
    result.state !== "known" || typeof result.final !== "boolean" ||
    !witness || typeof witness !== "object" || Array.isArray(witness) ||
    typeof witness.source !== "string" || !witness.source.length ||
    !Number.isSafeInteger(witness.revision) || Number(witness.revision) < 0 ||
    Object.keys(witness).length !== 2 || Object.keys(result).length !== 4 ||
    !("value" in result)
  ) {
    throw new TypeError("Invalid known derived result");
  }
  return knownDerived(
    decode(result.value),
    witness.source,
    Number(witness.revision),
    result.final,
  );
}
export interface ReportedTokens {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache: { read: number | null; write: number | null };
}
/** Execution state is independent of whether a trustworthy endpoint survived. */
export type TurnTiming =
  | { state: "known"; start: number; end: number; workingMs: number }
  | { state: "active"; start: number; workingMs: number }
  | {
    state: "unknown";
    start: number;
    end?: number;
    terminal: boolean;
    reason: "migration" | "missing-end" | "incomplete-evidence";
    explanation?: string;
  };
export interface UsageSummary {
  calls: number;
  cost: number | null;
  tokens: ReportedTokens;
  time?: { start: number; end?: number };
  timing?: TurnTiming;
  contextPeak: number | null;
}
export interface SessionDigest {
  refreshing?: boolean;
  stale?: boolean;
  error?: string;
  state: "digesting" | "ready" | "unavailable";
  revision: number;
  digestedAt?: number;
  nativeUpdatedAt?: number;
  messageCount?: number;
  total?: Derived<UsageSummary>;
  turns: Record<string, Derived<UsageSummary>>;
  last?: Derived<ReportedContext>;
  helper?: HelperSummary;
}
export interface ReportedContext {
  /** Null only for retained pre-contract cache rows without native identity. */
  callID: string | null;
  agent?: string;
  model?: ModelRef;
  context?: ReportedTokens;
}
export interface Tombstone {
  at: number;
  how: "otk" | "provider";
}
export interface DigestDelta {
  summary: Omit<SessionDigest, "turns" | "helper">;
  helper?: HelperSummary | null;
  turns: { upsert: Record<string, Derived<UsageSummary>>; remove: string[] };
  deleted: Tombstone | null;
}
