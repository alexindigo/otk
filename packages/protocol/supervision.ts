// SPDX-License-Identifier: LGPL-3.0-only
/** Adapter-owned positive evidence. Absence is never proof of activity. */
export interface EvidenceInventory {
  keys: readonly string[];
  fresh: boolean;
}
export type TerminalOutcome = "succeeded" | "failed" | "interrupted";
export interface TerminalEvidence {
  terminal?: number;
  /** Outcome belongs only to this exact terminal watermark; absent means unknown. */
  outcome?: TerminalOutcome;
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
      };
    } else if (value.outcome) {
      result = { terminal: value.terminal, outcome: value.outcome };
    }
  }
  return result;
}
export interface SupervisionEvidence extends TerminalEvidence {
  work?: EvidenceInventory;
  inputs?: EvidenceInventory;
  permissions?: EvidenceInventory;
  /** Monotone provider completion watermark, never an OTK observation clock. */
  terminal?: number;
}
export interface Supervision extends TerminalEvidence {
  state: "needsYou" | "working" | "finishedUnseen" | "none";
  terminal: number;
}
