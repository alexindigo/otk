// SPDX-License-Identifier: LGPL-3.0-only
/** Adapter-owned positive evidence. Absence is never proof of activity. */
export interface EvidenceInventory {
  keys: readonly string[];
  fresh: boolean;
  /** Optional adapter-owned scalar work facts, independent of acquired bodies. */
  items?: readonly {
    id: string;
    kind: "shell" | "execution";
    label: string;
    title: string;
    startedAt?: number;
  }[];
}
export type TerminalOutcome = "succeeded" | "failed" | "interrupted";
export interface TerminalEvidence {
  terminal?: number;
  /** Provider-owned terminal record identity, scoped to this child and source. */
  runID?: string;
  /** Outcome belongs only to this exact terminal watermark; absent means unknown. */
  outcome?: TerminalOutcome;
  /** Acquired history/backfill is state, never a new live terminal edge. */
  terminalOrigin?: "live" | "historical";
  /** Native scalar history proves exactly one terminal record at this token.
   * Null revokes an earlier proof when history is ambiguous or the edge is live. */
  legacyAcknowledgement?: { terminal: number; runID: string } | null;
  /** Public native failure facts for this exact terminal, independent of bodies. */
  terminalFailure?: import("./requests.ts").PublicFailure;
}
/** Parent-owned positive receipt, correlated by the plugin to this exact run.
 * This is not a human-view event and never covers a later child terminal. */
export interface DeliveredEvidence {
  parentID: string;
  receipt: string;
  terminal: number;
  runID?: string;
}
/** Merge terminal facts as a pair. A newer unknown end never inherits old success. */
export function latestTerminal(
  ...values: readonly (TerminalEvidence | undefined)[]
): TerminalEvidence {
  let result: TerminalEvidence = {};
  for (const value of values) {
    if (!value?.terminal || value.terminal < (result.terminal ?? 0)) continue;
    const prior = result;
    const replaces = value.terminal > (result.terminal ?? 0) ||
      !!(value.runID && result.runID && value.runID !== result.runID);
    if (replaces) {
      result = {
        terminal: value.terminal,
        ...(value.runID ? { runID: value.runID } : {}),
        // Explicit absence clears an older outcome in composed activity objects.
        outcome: value.outcome,
        ...(value.terminalOrigin
          ? { terminalOrigin: value.terminalOrigin }
          : {}),
        ...(value.terminalFailure
          ? { terminalFailure: value.terminalFailure }
          : {}),
      };
    } else {
      result = {
        ...result,
        ...(value.runID ? { runID: value.runID } : {}),
        ...(value.outcome ? { outcome: value.outcome } : {}),
        ...(value.terminalOrigin
          ? { terminalOrigin: value.terminalOrigin }
          : {}),
        ...(value.terminalFailure
          ? { terminalFailure: value.terminalFailure }
          : {}),
      };
    }
    const proof = value.legacyAcknowledgement !== undefined
      ? value.legacyAcknowledgement
      : replaces
      ? undefined
      : prior.legacyAcknowledgement;
    if (proof !== undefined || prior.legacyAcknowledgement !== undefined) {
      // Also overwrite stale proof when composed over other activity fields.
      result.legacyAcknowledgement = proof?.terminal === result.terminal &&
          proof?.runID === result.runID && value.terminalOrigin !== "live" &&
          (replaces || prior.terminalOrigin !== "live")
        ? proof
        : null;
    }
  }
  return result;
}
export interface SupervisionEvidence extends TerminalEvidence {
  /** Native completion inputs: positive pending work or an idle/empty read
   * fenced to this exact live terminal. Historical enrichment cannot confirm
   * a run or erase a run's already observed live edge. */
  completion?: {
    pending: readonly string[];
    /** Current, corroborated own continuation. A pending read or an uncertain
     * return can hold settlement without providing work evidence. */
    continuation?: readonly string[];
    confirmed?: number;
  };
  delivered?: DeliveredEvidence;
  work?: EvidenceInventory;
  inputs?: EvidenceInventory;
  permissions?: EvidenceInventory;
  /** Monotone provider completion watermark, never an OTK observation clock. */
  terminal?: number;
}
/** The entity owner's verdict, not a second interpretation of a run end. */
export interface SessionSettlement {
  id: number;
  outcome: TerminalOutcome;
  live: boolean;
  unseen: boolean;
}
export interface SettlementChange {
  sessionID: string;
  value: SessionSettlement | null;
}
export interface Supervision extends TerminalEvidence {
  state: "needsYou" | "working" | "finishedUnseen" | "none";
  terminal: number;
  /** Independent of the winning activity state. Missing on older peers is false. */
  unseen?: boolean;
  settlement?: SessionSettlement;
}
