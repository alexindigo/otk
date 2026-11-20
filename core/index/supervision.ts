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
    const delivery = evidence?.delivered;
    const delivered = delivery && delivery.parentID === entry.parentID &&
        delivery.receipt.length > 0 &&
        Number.isSafeInteger(delivery.terminal) &&
        delivery.terminal > 0
      ? delivery.terminal
      : 0;
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
    const needsInput = this.#fresh &&
      (evidence?.inputs?.fresh && evidence.inputs.keys.length ||
        evidence?.permissions?.fresh && evidence.permissions.keys.length &&
          (!this.#permissions || this.#permissions(entry.id) > 0));
    const state = needsInput
      ? "needsYou"
      : this.#fresh && evidence?.work?.fresh && evidence.work.keys.length
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
  status(value: Supervision): ProjectStatus {
    return value.state === "needsYou"
      ? "blocked"
      : value.state === "finishedUnseen"
      ? "finished"
      : value.state;
  }
}
