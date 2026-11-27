// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import type { EntityState, IndexEntry, SettlementChange } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { decodeIndexObservation } from "./index.ts";

export interface EntryChange {
  id: string;
  before?: IndexEntry;
  after?: IndexEntry;
  /** The accepted entity owner publication; null means no current authority. */
  entity?: EntityState | null;
  /** Coverage admitted an existing row, not a transition to its current state. */
  admitted?: true;
}
export interface EntryChanges {
  generation: string;
  revision: number;
  baseline: boolean;
  changes: readonly EntryChange[];
  settlements?: readonly SettlementChange[];
}
/** Permission routing for inventory consumers of an accepted projection. */
export const permissionRouting = (entry?: IndexEntry): {
  keys: readonly string[];
  fresh: boolean;
} | undefined => entry && decodeIndexObservation(entry).native?.permissions;
export interface AttentionProjection {
  get(id: string): IndexEntry | undefined;
  update(ids: readonly string[], baseline?: boolean, admitted?: boolean): void;
  subscribe(listener: (changes: EntryChanges) => void): () => void;
  settled(values: NonNullable<EntryChanges["settlements"]>): void;
  reset(): void;
  stop(): void;
}
/** Borrows the canonical index/adjacency; retains projected values and boundary facts. */
export function createAttentionProjection(o: {
  entry(id: string): IndexEntry | undefined;
  ids(): readonly string[];
  entity?(id: string): EntityState | undefined;
  factory?: StateFactory;
}): AttentionProjection {
  const values = new Map<string, IndexEntry>();
  const published = new Map<string, EntityState>();
  const listeners = new Set<(changes: EntryChanges) => void>();
  const clock = (o.factory ?? createState)({
    keys: {} as Record<string, number>,
  });
  let initialized = false, stopped = false;
  let generation = randomID(), revision = 0;
  const facts = (entry?: IndexEntry) =>
    entry && JSON.stringify([
      entry.title,
      entry.parentID,
      entry.directory,
      entry.archived,
      entry.deleted,
      decodeIndexObservation(entry),
    ]);
  const update = (
    ids: readonly string[],
    baseline = false,
    admitted = false,
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
        previous = published.get(id),
        entity = o.entity?.(id),
        evidence = entity?.evidence;
      if (entity) published.set(id, entity);
      else published.delete(id);
      const permissions = evidence?.requests?.permissions.map(({ id }) => id) ??
        [];
      const questions = evidence?.requests?.questions.map(({ id }) => id) ?? [];
      const after = raw && o.entity
        ? {
          ...raw,
          attention: {
            ...decodeIndexObservation(raw).diagnostic,
            permissions: permissions.length,
            questions: evidence?.questions ?? 0,
          },
          activity: {
            ...decodeIndexObservation(raw).native,
            permissions: { keys: permissions, fresh: !!evidence },
            inputs: { keys: questions, fresh: !!evidence },
          },
        }
        : raw;
      if (after) values.set(id, after);
      else values.delete(id);
      if (
        rebuild ||
        facts(before) !== facts(after) ||
        JSON.stringify(previous) !== JSON.stringify(entity)
      ) {
        changes.push({
          id,
          before,
          after,
          ...(o.entity ? { entity: entity ?? null } : {}),
          ...(admitted ? { admitted: true as const } : {}),
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
  return {
    get(id) {
      void clock.state.keys[id];
      return values.get(id);
    },
    update,
    subscribe(listener) {
      if (stopped) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled(settlements) {
      if (stopped || !initialized) return;
      const event = {
        generation,
        revision: ++revision,
        baseline: false,
        changes: [],
        settlements,
      };
      for (const listener of listeners) listener(event);
    },
    reset() {
      initialized = false;
      published.clear();
      generation = randomID();
      revision = 0;
    },
    stop() {
      stopped = true;
      values.clear();
      published.clear();
      listeners.clear();
      clock.update((state) => {
        state.keys = {};
      });
    },
  };
}
