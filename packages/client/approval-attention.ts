// SPDX-License-Identifier: LGPL-3.0-only
import {
  autoApproveOwner,
  type IndexEntry,
  type IndexMetadata,
  type PermissionRequest,
  sessionAncestors,
  type SessionLookup,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

export interface EntryChange {
  id: string;
  before?: IndexEntry;
  after?: IndexEntry;
}
export interface EntryChanges {
  generation: string;
  revision: number;
  baseline: boolean;
  changes: readonly EntryChange[];
}
export interface AttentionProjection {
  get(id: string): IndexEntry | undefined;
  configure(enabled: readonly string[], linked: boolean): void;
  update(ids: readonly string[], baseline?: boolean): void;
  subscribe(listener: (changes: EntryChanges) => void): () => void;
  reset(): void;
  stop(): void;
}
/** Borrows the canonical index/adjacency; retains projected values and boundary facts. */
export function createAttentionProjection(o: {
  entry(id: string): IndexEntry | undefined;
  ids(): readonly string[];
  children(id: string): readonly string[];
  factory?: StateFactory;
}): AttentionProjection {
  const values = new Map<string, IndexEntry>();
  const covered = new Set<string>();
  const boundaries = new Map<string, { count: number; ancestors: string[] }>();
  const subtracted = new Map<string, number>();
  const listeners = new Set<(changes: EntryChanges) => void>();
  const clock = (o.factory ?? createState)({
    keys: {} as Record<string, number>,
  });
  let enabled = new Set<string>(),
    linked = false,
    initialized = false,
    stopped = false;
  let generation = crypto.randomUUID(), revision = 0;
  let waitingCache = new Map<string, boolean>();
  const waiting = (id: string) => {
    if (!linked) return true;
    const seen = new Set<string>();
    let result = true;
    while (!seen.has(id)) {
      if (waitingCache.has(id)) {
        result = waitingCache.get(id)!;
        break;
      }
      if (enabled.has(id)) {
        result = false;
        break;
      }
      seen.add(id);
      const parent = o.entry(id)?.parentID;
      if (!parent) break;
      id = parent;
    }
    for (const current of seen) waitingCache.set(current, result);
    return result;
  };
  const subtree = (id: string, ids: Set<string>) => {
    const pending = new Set([id]);
    for (const current of pending) {
      ids.add(current);
      for (const child of o.children(current)) pending.add(child);
    }
  };
  const facts = (entry?: IndexEntry) =>
    entry && JSON.stringify([
      entry.title,
      entry.status,
      entry.parentID,
      entry.directory,
      entry.archived,
      entry.deleted,
      entry.attention,
    ]);
  const update = (
    ids: readonly string[],
    baseline = false,
    forceSubtree = false,
  ) => {
    if (stopped) return;
    waitingCache = new Map();
    const touched = new Set(ids), rebuild = baseline || !initialized;
    if (rebuild) {
      for (const id of values.keys()) touched.add(id);
      for (const id of o.ids()) touched.add(id);
      boundaries.clear();
      subtracted.clear();
      covered.clear();
    } else {
      for (const id of ids) {
        if (
          forceSubtree || values.get(id)?.parentID !== o.entry(id)?.parentID ||
          !!values.get(id) !== !!o.entry(id)
        ) subtree(id, touched);
      }
    }
    const affected = new Set(touched);
    for (const id of touched) {
      const old = boundaries.get(id);
      if (old) {
        for (const ancestor of old.ancestors) {
          subtracted.set(ancestor, (subtracted.get(ancestor) ?? 0) - old.count);
          affected.add(ancestor);
        }
      }
      boundaries.delete(id);
      if (o.entry(id) && !waiting(id)) covered.add(id);
      else covered.delete(id);
    }
    for (const id of touched) {
      const raw = o.entry(id);
      if (!raw || !covered.has(id) || raw.parentID && !waiting(raw.parentID)) {
        continue;
      }
      const contribution = {
        count: raw.attention.permissions + raw.attention.childPermissions,
        ancestors: sessionAncestors(id, o.entry),
      };
      boundaries.set(id, contribution);
      for (const ancestor of contribution.ancestors) {
        subtracted.set(
          ancestor,
          (subtracted.get(ancestor) ?? 0) + contribution.count,
        );
        affected.add(ancestor);
      }
    }
    const changes: EntryChange[] = [];
    for (const id of affected) {
      const before = values.get(id), raw = o.entry(id);
      const count = subtracted.get(id) ?? 0;
      if (!count) subtracted.delete(id);
      const after = raw && (covered.has(id) || count
        ? {
          ...raw,
          attention: {
            ...raw.attention,
            permissions: covered.has(id) ? 0 : raw.attention.permissions,
            childPermissions: covered.has(id)
              ? 0
              : Math.max(0, raw.attention.childPermissions - count),
          },
        }
        : raw);
      if (after) values.set(id, after);
      else values.delete(id);
      if (rebuild || facts(before) !== facts(after)) {
        changes.push({ id, before, after });
      }
    }
    initialized = true;
    clock.update((state) => {
      for (const id of affected) state.keys[id] = (state.keys[id] ?? 0) + 1;
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
    configure(next, live) {
      if (stopped) return;
      const incoming = new Set(next);
      const dirty = [...new Set([...enabled, ...incoming])].filter((id) =>
        enabled.has(id) !== incoming.has(id)
      );
      const linkChanged = linked !== live;
      enabled = incoming;
      linked = live;
      if (!initialized || !dirty.length && !linkChanged) return;
      if (linkChanged) update(o.ids());
      else update(dirty, false, true);
    },
    update,
    subscribe(listener) {
      if (stopped) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      initialized = false;
      generation = crypto.randomUUID();
      revision = 0;
    },
    stop() {
      stopped = true;
      values.clear();
      covered.clear();
      boundaries.clear();
      subtracted.clear();
      listeners.clear();
      waitingCache.clear();
      clock.update((state) => {
        state.keys = {};
      });
    },
  };
}

/** One definition of waiting for the user, shared by requests and index consumers.
 * Native pending metadata is retained unchanged for reconnect and policy changes. */
export interface ApprovalAttention {
  waiting(sessionID: string): boolean;
  permissions(requests: readonly PermissionRequest[]): PermissionRequest[];
  entries<T extends IndexMetadata>(entries: readonly T[]): T[];
}
export function approvalAttention(
  enabled: readonly string[],
  lookup: SessionLookup,
  linked: boolean,
): ApprovalAttention {
  const waiting = (id: string) =>
    !linked || !autoApproveOwner(id, enabled, lookup);
  return {
    waiting,
    permissions: (requests: readonly PermissionRequest[]) =>
      requests.filter((r) => waiting(r.sessionID)),
    entries<T extends IndexMetadata>(entries: readonly T[]): T[] {
      if (!linked || !enabled.length) return [...entries];
      // Subtract each covered subtree once, even when an uncovered ancestor has
      // both manual and automatic helper branches. Native roll-ups may include
      // descendants outside the visible index window.
      const boundaries = entries.filter((e) =>
        !waiting(e.id) && (!e.parentID || waiting(e.parentID))
      );
      return entries.map((entry) => {
        const covered = !waiting(entry.id);
        const childCovered = covered
          ? entry.attention.childPermissions
          : boundaries.reduce((sum, subtree) =>
            sessionAncestors(subtree.id, lookup).includes(entry.id)
              ? sum + subtree.attention.permissions +
                subtree.attention.childPermissions
              : sum, 0);
        return {
          ...entry,
          attention: {
            ...entry.attention,
            permissions: covered ? 0 : entry.attention.permissions,
            childPermissions: Math.max(
              0,
              entry.attention.childPermissions - childCovered,
            ),
          },
        };
      });
    },
  };
}
