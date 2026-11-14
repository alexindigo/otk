// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexMetadata, ProjectStatus, Supervision } from "@otk/protocol";

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
  ): Supervision {
    const evidence = entry.activity;
    const terminal = Math.max(retainedTerminal, evidence?.terminal ?? 0);
    const outcome = terminal === evidence?.terminal
      ? evidence.outcome
      : undefined;
    if (entry.deleted) {
      return { state: "none", terminal, ...(outcome ? { outcome } : {}) };
    }
    const needsInput = this.#fresh &&
      (evidence?.inputs?.fresh && evidence.inputs.keys.length ||
        evidence?.permissions?.fresh && evidence.permissions.keys.length &&
          (!this.#permissions || this.#permissions(entry.id) > 0));
    const state = needsInput
      ? "needsYou"
      : this.#fresh && evidence?.work?.fresh && evidence.work.keys.length
      ? "working"
      : terminal > acknowledged
      ? "finishedUnseen"
      : "none";
    return { state, terminal, ...(outcome ? { outcome } : {}) };
  }
  status(value: Supervision): ProjectStatus {
    return value.state === "needsYou"
      ? "blocked"
      : value.state === "finishedUnseen"
      ? "finished"
      : value.state;
  }
}
