// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import type {
  EntityState,
  IndexEntry,
  TerminalEvidence,
  TerminalOutcome,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

export interface EntryChange {
  id: string;
  before?: IndexEntry;
  after?: IndexEntry;
  completedAt?: number;
  completedOutcome?: TerminalOutcome;
  completedUnseen?: boolean;
  completionOrigin?: "live" | "historical";
  completedFailure?: TerminalEvidence["terminalFailure"];
}
export interface EntryChanges {
  generation: string;
  revision: number;
  baseline: boolean;
  changes: readonly EntryChange[];
}
export interface AttentionProjection {
  get(id: string): IndexEntry | undefined;
  update(ids: readonly string[], baseline?: boolean): void;
  finished(
    id: string,
    time: number,
    baseline?: boolean,
    outcome?: TerminalOutcome,
    unseen?: boolean,
    evidence?: TerminalEvidence,
  ): void;
  /** Admission replays known state, even when it advances an older clock. */
  admitFinished(
    id: string,
    time: number,
    outcome?: TerminalOutcome,
    unseen?: boolean,
    evidence?: TerminalEvidence,
  ): void;
  subscribe(listener: (changes: EntryChanges) => void): () => void;
  reset(): void;
  stop(): void;
}
/** Borrows the canonical index/adjacency; retains projected values and boundary facts. */
export function createAttentionProjection(o: {
  entry(id: string): IndexEntry | undefined;
  ids(): readonly string[];
  entity?(id: string): EntityState | undefined;
  completions?: boolean;
  factory?: StateFactory;
}): AttentionProjection {
  const values = new Map<string, IndexEntry>();
  const finishClocks = new Map<
    string,
    TerminalEvidence & {
      unseen?: boolean;
      seeded: boolean;
      observedLive: boolean;
    }
  >();
  const completed = new Map<string, TerminalEvidence & { unseen?: boolean }>();
  const listeners = new Set<(changes: EntryChanges) => void>();
  const clock = (o.factory ?? createState)({
    keys: {} as Record<string, number>,
  });
  let initialized = false, stopped = false;
  let generation = randomID(), revision = 0;
  const facts = (entry?: IndexEntry) =>
    entry && JSON.stringify([
      entry.title,
      entry.status,
      entry.parentID,
      entry.directory,
      entry.archived,
      entry.deleted,
      entry.attention,
      entry.activity,
    ]);
  const update = (
    ids: readonly string[],
    baseline = false,
    completion = false,
  ) => {
    if (stopped) return;
    const touched = new Set(ids), rebuild = baseline || !initialized;
    if (rebuild) {
      for (const id of values.keys()) touched.add(id);
      for (const id of o.ids()) touched.add(id);
    }
    const changes: EntryChange[] = [];
    for (const id of touched) {
      const before = values.get(id),
        raw = o.entry(id),
        evidence = o.entity?.(id)?.evidence;
      const permissions = evidence?.requests?.permissions.map(({ id }) => id) ??
        [];
      const after = raw && o.entity
        ? {
          ...raw,
          attention: {
            ...raw.attention,
            permissions: permissions.length,
            questions: evidence?.questions ?? 0,
          },
          activity: {
            ...raw.activity,
            permissions: { keys: permissions, fresh: !!evidence },
          },
        }
        : raw;
      if (after) values.set(id, after);
      else values.delete(id);
      if (
        rebuild || completion && touched.has(id) ||
        facts(before) !== facts(after)
      ) {
        changes.push({
          id,
          before,
          after,
          ...(o.completions && (
              completion || !!after && (!before ||
                  before.status !== "idle" && after.status === "idle")
            )
            ? {
              completedAt: completed.get(id)?.terminal ?? 0,
              completedOutcome: completed.get(id)?.outcome,
              completedUnseen: completed.get(id)?.unseen,
              completionOrigin: completed.get(id)?.terminalOrigin,
              completedFailure: completed.get(id)?.terminalFailure,
            }
            : {}),
        });
      }
    }
    initialized = true;
    clock.update((state) => {
      for (const { id } of changes) state.keys[id] = (state.keys[id] ?? 0) + 1;
    });
    if (changes.length || rebuild) {
      const event = {
        generation,
        revision: ++revision,
        baseline: rebuild,
        changes,
      };
      for (const listener of listeners) listener(event);
    }
  };
  const finished = (
    id: string,
    time: number,
    baseline = false,
    outcome?: TerminalOutcome,
    unseen?: boolean,
    evidence?: TerminalEvidence,
    admitted = false,
  ) => {
    const previous = finishClocks.get(id);
    if (
      stopped || previous !== undefined &&
        (time < (previous.terminal ?? 0) ||
          time === previous.terminal &&
            (!outcome || outcome === previous.outcome) &&
            unseen === previous.unseen &&
            JSON.stringify(evidence?.terminalFailure) ===
              JSON.stringify(previous.terminalFailure) &&
            (evidence?.terminalOrigin !== "live" || previous.observedLive ||
              previous.seeded))
    ) return;
    const same = previous?.terminal === time;
    const replay = baseline || admitted ||
      evidence?.terminalOrigin === "historical" ||
      same && (previous.observedLive || previous.seeded);
    const value = {
      terminal: time,
      ...(outcome ? { outcome } : {}),
      unseen,
      terminalOrigin: replay ? "historical" as const : "live" as const,
      ...(evidence?.terminalFailure
        ? { terminalFailure: evidence.terminalFailure }
        : {}),
    };
    finishClocks.set(id, {
      ...value,
      seeded: baseline || admitted || same && previous.seeded,
      observedLive: !replay || same && previous.observedLive,
    });
    completed.set(id, value);
    update([id], false, true);
  };
  return {
    get(id) {
      void clock.state.keys[id];
      return values.get(id);
    },
    update,
    finished,
    admitFinished(id, time, outcome, unseen, evidence) {
      finished(id, time, false, outcome, unseen, evidence, true);
    },
    subscribe(listener) {
      if (stopped) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      initialized = false;
      finishClocks.clear();
      completed.clear();
      generation = randomID();
      revision = 0;
    },
    stop() {
      stopped = true;
      values.clear();
      finishClocks.clear();
      completed.clear();
      listeners.clear();
      clock.update((state) => {
        state.keys = {};
      });
    },
  };
}
