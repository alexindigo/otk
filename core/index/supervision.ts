// SPDX-License-Identifier: LGPL-3.0-only
import type {
  IndexMetadata,
  ProjectStatus,
  Supervision,
  TerminalOutcome,
} from "@otk/protocol";

/** A parent receiving an error is not a human acknowledging the failure.
 * Awaiting user ruling C1 (decisions-coherence section 6); do not change
 * without it. */
export function failedHelperNeedsAck(
  entry: Pick<IndexMetadata, "parentID">,
  outcome: TerminalOutcome | undefined,
): boolean {
  return !!entry.parentID && outcome === "failed";
}
/** WP11's run-correlated parent receipt, independently of human acknowledgement. */
export function deliveredTerminal(entry: IndexMetadata): number {
  const receipt = entry.activity?.delivered;
  return receipt && receipt.parentID === entry.parentID &&
      receipt.receipt.length > 0 &&
      Number.isSafeInteger(receipt.terminal) && receipt.terminal > 0
    ? receipt.terminal
    : 0;
}
/** Fresh positive evidence as the interpreter counts it; absence is zero. */
export interface SessionInputs {
  work: boolean;
  /** Own pending permissions left after the approval policy. */
  permissions: number;
  /** Own pending questions and forms. */
  questions: number;
}

/** The sole server-side interpreter of adapter evidence and OTK acknowledgements.
 * Population/digest freshness is intentionally not an activity input. */
export class SessionSupervision {
  #fresh = true;
  #permissions?: (id: string) => number;
  freshness(fresh: boolean): void {
    this.#fresh = fresh;
  }
  permissions(lookup: (id: string) => number): void {
    this.#permissions = lookup;
  }
  session(
    entry: IndexMetadata,
    acknowledged: number,
    retainedTerminal = 0,
    inputs = this.inputs(entry),
  ): Supervision {
    const evidence = entry.activity;
    const terminal = Math.max(retainedTerminal, evidence?.terminal ?? 0);
    const outcome = terminal === evidence?.terminal
      ? evidence.outcome
      : undefined;
    const detail = terminal === evidence?.terminal
      ? {
        ...(evidence.terminalOrigin
          ? { terminalOrigin: evidence.terminalOrigin }
          : {}),
        ...(evidence.terminalFailure
          ? { terminalFailure: evidence.terminalFailure }
          : {}),
      }
      : {};
    const helperFailed = failedHelperNeedsAck(entry, outcome);
    const delivered = helperFailed ? 0 : deliveredTerminal(entry);
    const unseen = terminal > Math.max(acknowledged, delivered);
    if (entry.deleted) {
      return {
        state: "none",
        terminal,
        unseen: false,
        ...detail,
        ...(outcome ? { outcome } : {}),
      };
    }
    const needsInput = inputs.questions > 0 || inputs.permissions > 0;
    // A failed top-level run needs acknowledgement, not a successful-finish
    // lamp (2.72). Delivered-helper treatment remains the isolated C1 rule.
    const failedRun = unseen &&
      (helperFailed || !entry.parentID && outcome === "failed");
    const state = needsInput || failedRun
      ? "needsYou"
      : inputs.work
      ? "working"
      : unseen
      ? "finishedUnseen"
      : "none";
    return {
      state,
      terminal,
      unseen,
      ...detail,
      ...(outcome ? { outcome } : {}),
    };
  }
  inputs(entry: IndexMetadata): SessionInputs {
    const evidence = entry.activity;
    if (!this.#fresh) return { work: false, permissions: 0, questions: 0 };
    const permissions = evidence?.permissions?.fresh &&
        evidence.permissions.keys.length
      ? this.#permissions
        ? Math.max(0, this.#permissions(entry.id))
        : evidence.permissions.keys.length
      : 0;
    return {
      work: !!(evidence?.work?.fresh && evidence.work.keys.length),
      permissions,
      questions: evidence?.inputs?.fresh ? evidence.inputs.keys.length : 0,
    };
  }
  status(value: Supervision): ProjectStatus {
    return value.state === "needsYou"
      ? "blocked"
      : value.state === "finishedUnseen"
      ? "finished"
      : value.state;
  }
}
