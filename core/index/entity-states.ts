// SPDX-License-Identifier: LGPL-3.0-only
import {
  type BlockedCause,
  type EntityCounts,
  entityKey,
  type EntityState,
  type IndexMetadata,
  type ProjectStatus,
  type SessionEvidence,
  type Supervision,
} from "@otk/protocol";
import {
  failedHelperNeedsAck,
  type SessionSupervision,
} from "./supervision.ts";

/** Session family facts the owner borrows; it never scans the catalog. */
export interface EntityFamily {
  getMetadata(id: string): IndexMetadata | undefined;
  ancestors(id: string): readonly string[];
  descendants(id: string): ReadonlySet<string>;
}

/** A member's contribution to the counts: itself, by its own state. */
function own(state: ProjectStatus, unseen: boolean): EntityCounts {
  return {
    blocked: state === "blocked" ? 1 : 0,
    working: state === "working" ? 1 : 0,
    finished: state === "finished" ? 1 : 0,
    unseen: unseen ? 1 : 0,
  };
}

/** Decision 62: the one per-user state of every entity, updated from signals.
 * Session state is SessionSupervision's verdict; every indicator derives from
 * the published EntityState, never from a second interpretation. */
export class EntityStates {
  #states = new Map<string, EntityState>();
  /** Own counts of each live session, for its ancestors' descendant evidence. */
  #own = new Map<string, EntityCounts>();
  /** Last published parent, so a moved or removed session updates its old family. */
  #parents = new Map<string, string>();
  constructor(
    readonly supervision: SessionSupervision,
    readonly family: EntityFamily,
    readonly publish: (
      upserts: readonly EntityState[],
      removals: readonly string[],
    ) => void,
  ) {}
  get(key: string): EntityState | undefined {
    return this.#states.get(key);
  }
  /** The live keyed map, copied by snapshot assembly like the other maps. */
  values(): Map<string, EntityState> {
    return this.#states;
  }
  /** A new user generation starts without transitions from the previous one. */
  reset(): void {
    this.#states.clear();
    this.#own.clear();
    this.#parents.clear();
  }
  /** Interpret one session, publish its state and its ancestors' descendant
   * evidence. Returns the supervision verdict it was derived from. */
  session(
    entry: IndexMetadata,
    acknowledged: number,
    retainedTerminal = 0,
  ): Supervision {
    const verdict = this.supervision.session(
      entry,
      acknowledged,
      retainedTerminal,
    );
    const upserts: EntityState[] = [], removals: string[] = [];
    const parent = this.#parents.get(entry.id);
    const moved = parent !== entry.parentID;
    if (moved) {
      if (parent) this.#chain(parent, upserts);
      if (entry.parentID) this.#parents.set(entry.id, entry.parentID);
      else this.#parents.delete(entry.id);
    }
    if (entry.deleted) {
      this.#retire(entry.id, removals);
      this.#ancestors(entry.id, upserts);
    } else {
      const state = this.supervision.status(verdict);
      const counts = own(state, verdict.unseen === true);
      const before = this.#own.get(entry.id);
      this.#own.set(entry.id, counts);
      const value = this.#session(entry, verdict, state, counts);
      if (this.#set(value)) upserts.push(value);
      if (moved || JSON.stringify(before) !== JSON.stringify(counts)) {
        this.#ancestors(entry.id, upserts);
      }
    }
    if (upserts.length || removals.length) this.publish(upserts, removals);
    return verdict;
  }
  /** A session left the index: its state is none and its entity is gone. */
  remove(id: string): void {
    const upserts: EntityState[] = [], removals: string[] = [];
    const parent = this.#parents.get(id);
    this.#retire(id, removals);
    if (parent) this.#chain(parent, upserts);
    if (upserts.length || removals.length) this.publish(upserts, removals);
  }
  #retire(id: string, removals: string[]): void {
    this.#own.delete(id);
    this.#parents.delete(id);
    const key = entityKey("session", id);
    if (this.#states.delete(key)) removals.push(key);
  }
  #ancestors(id: string, upserts: EntityState[]): void {
    for (const parent of this.family.ancestors(id)) {
      this.#refresh(parent, upserts);
    }
  }
  #chain(id: string, upserts: EntityState[]): void {
    this.#refresh(id, upserts);
    this.#ancestors(id, upserts);
  }
  #refresh(id: string, upserts: EntityState[]): void {
    const current = this.#states.get(entityKey("session", id));
    if (!current?.evidence) return;
    const descendants = this.#descendants(id);
    if (
      JSON.stringify(descendants) ===
        JSON.stringify(current.evidence.descendants)
    ) return;
    const value = {
      ...current,
      evidence: { ...current.evidence, descendants },
    };
    this.#states.set(entityKey("session", id), value);
    upserts.push(value);
  }
  #descendants(id: string): EntityCounts {
    const sum = own("none", false);
    for (const child of this.family.descendants(id)) {
      if (child === id) continue;
      const counts = this.#own.get(child);
      if (!counts) continue;
      sum.blocked += counts.blocked;
      sum.working += counts.working;
      sum.finished += counts.finished;
      sum.unseen += counts.unseen;
    }
    return sum;
  }
  #session(
    entry: IndexMetadata,
    verdict: Supervision,
    state: ProjectStatus,
    counts: EntityCounts,
  ): EntityState {
    const inputs = this.supervision.inputs(entry);
    const activity = entry.activity;
    const cause: BlockedCause | undefined = state !== "blocked"
      ? undefined
      // Immediate causes win over the graced one: grace applies only when a
      // permission is the sole reason.
      : inputs.questions > 0
      ? "question"
      : inputs.permissions > 0
      ? "permission"
      : failedHelperNeedsAck(entry, verdict.outcome)
      ? "failedHelper"
      : undefined;
    const items = inputs.work
      ? (activity?.work?.items ?? []).filter((item) =>
        activity?.work?.keys.includes(item.id)
      )
      : [];
    const evidence: SessionEvidence = {
      work: inputs.work,
      permissions: inputs.permissions,
      questions: inputs.questions,
      descendants: this.#descendants(entry.id),
      requests: {
        permissions: inputs.permissions > 0
          ? (activity?.permissions?.keys ?? []).map((id) => ({ id }))
          : [],
        questions: inputs.questions > 0
          ? (activity?.inputs?.keys ?? []).map((id) => ({ id }))
          : [],
      },
      ...(items.length
        ? {
          liveWork: items.map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label,
            title: item.title,
            ...(item.startedAt === undefined
              ? {}
              : { startedAt: item.startedAt }),
            state: "working" as const,
          })),
        }
        : {}),
      ...(entry.status === "retry" && entry.retry
        ? { retry: { ...entry.retry } }
        : {}),
      ...(verdict.terminalFailure ? { failure: verdict.terminalFailure } : {}),
    };
    const before = this.#states.get(entityKey("session", entry.id));
    return {
      kind: "session",
      id: entry.id,
      state,
      ...(cause ? { cause } : {}),
      previous: !before
        ? "none"
        : before.state !== state
        ? before.state
        : before.previous,
      counts,
      ...(verdict.terminal ? { terminal: verdict.terminal } : {}),
      ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
      ...(verdict.terminalOrigin
        ? { terminalOrigin: verdict.terminalOrigin }
        : {}),
      evidence,
    };
  }
  #set(value: EntityState): boolean {
    const key = entityKey(value.kind, value.id);
    if (JSON.stringify(this.#states.get(key)) === JSON.stringify(value)) {
      return false;
    }
    this.#states.set(key, value);
    return true;
  }
}
