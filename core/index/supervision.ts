// SPDX-License-Identifier: LGPL-3.0-only
import type {
  IndexMetadata,
  ProjectStatus,
  Supervision,
  TerminalOutcome,
} from "@otk/protocol";

/** WP11's run-correlated parent receipt, independently of human acknowledgement. */
function deliveredTerminal(entry: IndexMetadata, terminal: number): boolean {
  const receipt = entry.activity?.delivered;
  return !!receipt && receipt.parentID === entry.parentID &&
      receipt.receipt.length > 0 &&
      Number.isSafeInteger(receipt.terminal) && receipt.terminal > 0 &&
      receipt.terminal === terminal;
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
    // D81: the same exact receipt covers success and failure, without replacing
    // the outcome or creating a human acknowledgement.
    const unseen = terminal > acknowledged && !deliveredTerminal(entry, terminal);
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
    const failedRun = unseen && outcome === "failed";
    const state = needsInput || failedRun
      ? "needsYou"
      : inputs.work
      ? "working"
      : unseen
      ? "finishedUnseen"
      : "none";
    const settlement = this.#fresh && entry.activityAuthority !== "stale" &&
        !entry.archived && !operation &&
        !needsInput && !inputs.work && terminal > 0 && outcome &&
        evidence?.completion?.confirmed === terminal
      ? {
        id: terminal,
        outcome,
        live: true,
        unseen,
      }
      : undefined;
    return {
      state,
      terminal,
      unseen,
      ...(settlement ? { settlement } : {}),
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
    const continuation = entry.activityAuthority !== "stale" &&
      !!evidence?.completion?.pending.length;
    return {
      work: continuation ||
        !!(evidence?.work?.fresh && evidence.work.keys.length),
      ...(continuation ? { continuation } : {}),
      permissions,
      questions: evidence?.inputs?.fresh ? evidence.inputs.keys.length : 0,
    };
  }
  /** D35/D69: this session's live work can supersede its own older finish. */
  status(value: Supervision, operation?: "working" | "blocked"): ProjectStatus {
    if (value.state === "needsYou" || operation === "blocked") return "blocked";
    if (operation === "working") return "working";
    return value.state === "finishedUnseen" ? "finished" : value.state;
  }
}
