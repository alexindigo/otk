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
  /** Outcome belongs only to this exact terminal watermark; absent means unknown. */
  outcome?: TerminalOutcome;
  /** Acquired history/backfill is state, never a new live terminal edge. */
  terminalOrigin?: "live" | "historical";
  /** Public native failure facts for this exact terminal, independent of bodies. */
  terminalFailure?: import("./requests.ts").PublicFailure;
}
/** Parent-owned positive receipt, correlated by the plugin to this exact run.
 * This is not a human-view event and never covers a later child terminal. */
export interface DeliveredEvidence {
  parentID: string;
  receipt: string;
  terminal: number;
}
/** Merge terminal facts as a pair. A newer unknown end never inherits old success. */
export function latestTerminal(
  ...values: readonly (TerminalEvidence | undefined)[]
): TerminalEvidence {
  let result: TerminalEvidence = {};
  for (const value of values) {
    if (!value?.terminal || value.terminal < (result.terminal ?? 0)) continue;
    if (value.terminal > (result.terminal ?? 0)) {
      result = {
        terminal: value.terminal,
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
        ...(value.outcome ? { outcome: value.outcome } : {}),
        ...(value.terminalOrigin
          ? { terminalOrigin: value.terminalOrigin }
          : {}),
        ...(value.terminalFailure
          ? { terminalFailure: value.terminalFailure }
          : {}),
      };
    }
  }
  return result;
}
export interface SupervisionEvidence extends TerminalEvidence {
  delivered?: DeliveredEvidence;
  work?: EvidenceInventory;
  inputs?: EvidenceInventory;
  permissions?: EvidenceInventory;
  /** Monotone provider completion watermark, never an OTK observation clock. */
  terminal?: number;
}
export interface Supervision extends TerminalEvidence {
  /** Running terminal programs owned by this session, not its own activity. */
  dependencies?: { running: number };
  state: "needsYou" | "working" | "finishedUnseen" | "none";
  terminal: number;
  /** Independent of the winning activity state. Missing on older peers is false. */
  unseen?: boolean;
}
