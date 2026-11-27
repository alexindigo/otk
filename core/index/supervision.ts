// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexMetadata,
  sessionTransition,
  type Supervision,
} from "@otk/protocol";

/** WP11's run-correlated parent receipt, independently of human acknowledgement. */
function deliveredTerminal(entry: IndexMetadata, terminal: number): boolean {
  const receipt = entry.activity?.delivered;
  return !!receipt && receipt.parentID === entry.parentID &&
    terminal === entry.activity?.terminal &&
    receipt.receipt.length > 0 &&
    Number.isSafeInteger(receipt.terminal) && receipt.terminal > 0 &&
    receipt.terminal === terminal &&
    (receipt.runID || entry.activity?.runID
      ? !!receipt.runID && receipt.runID === entry.activity?.runID
      : true);
}
/** Fresh positive evidence as the interpreter counts it; absence is zero. */
export interface SessionInputs {
  work: boolean;
  continuation?: boolean;
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
    operation?: "working" | "blocked",
    opened = false,
  ): Supervision & ReturnType<typeof sessionTransition> {
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
    // D81: the same exact receipt covers success and failure, without replacing
    // the outcome or creating a human acknowledgement.
    const unseen = terminal > acknowledged &&
      !deliveredTerminal(entry, terminal);
    return {
      ...sessionTransition({
        ...inputs,
        deleted: !!entry.deleted,
        archived: entry.archived,
        fresh: this.#fresh && entry.activityAuthority !== "stale",
        helper: !!entry.parentID,
        opened,
        operation,
        terminal,
        outcome,
        unseen,
        confirmed: evidence?.completion?.confirmed,
      }),
      terminal,
      ...detail,
      ...(outcome ? { outcome } : {}),
    };
  }
  inputs(entry: IndexMetadata): SessionInputs {
    const evidence = entry.activity;
    if (!this.#fresh || entry.activityAuthority === "stale") {
      return { work: false, permissions: 0, questions: 0 };
    }
    const permissions = evidence?.permissions?.fresh &&
        evidence.permissions.keys.length
      ? this.#permissions
        ? Math.max(0, this.#permissions(entry.id))
        : evidence.permissions.keys.length
      : 0;
    const continuation = !!evidence?.completion?.continuation?.length;
    return {
      work: continuation ||
        !!(evidence?.work?.fresh && evidence.work.keys.length),
      ...(continuation ? { continuation } : {}),
      permissions,
      questions: evidence?.inputs?.fresh ? evidence.inputs.keys.length : 0,
    };
  }
}
