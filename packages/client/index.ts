// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";
import type { IndexEntry } from "@otk/protocol";
import type { ContentSession } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";

export interface MergedEntry extends IndexEntry {
  sidecarId: string;
}
export function sessionKey(sidecarId: string, sessionID: string): string {
  return `${sidecarId}/${sessionID}`;
}
export function liveSessionInfo(
  info: ContentSession | undefined,
  entry: IndexEntry | undefined,
): ContentSession | undefined {
  if (!info || !entry) return info;
  return {
    ...info,
    title: entry.title,
    directory: entry.directory,
    projectID: entry.projectID,
    parentID: entry.parentID,
    archived: entry.archived,
    time: { created: entry.timeCreated, updated: entry.timeUpdated },
  };
}
type IndexFrame = Extract<ServerFrame, { t: "index.snapshot" | "index.patch" }>;
export function acceptsPatch(
  revision: number | undefined,
  frame: IndexFrame,
): boolean {
  return frame.t === "index.snapshot" ||
    (revision !== undefined && frame.rev === revision + frame.ops.length);
}
export interface IndexState {
  entries: Record<string, MergedEntry>;
}
export interface ClientIndex {
  state: IndexState;
  get(sidecarId: string, sessionID: string): MergedEntry | undefined;
  ids(sidecarId: string, directory?: string): readonly string[];
  partition(sidecarId: string, directory?: string): MergedEntry[];
  subscribe(listener: (state: IndexState) => void): () => void;
  receive(sidecarId: string, frame: IndexFrame): boolean;
  remove(sidecarId: string): void;
}
export function createIndex(factory: StateFactory = createState): ClientIndex {
  // Data is synchronous and framework-free. The binding publishes only keyed
  // clocks, so deferred painting can never govern action admission.
  const entries: Record<string, MergedEntry> = {};
  const clock = factory({ revision: 0, keys: {} as Record<string, number> });
  const partitions = new Map<
    string,
    { members: Set<string>; ids?: readonly string[] }
  >();
  const partitionClock = factory({ keys: {} as Record<string, number> });
  const partitionKey = (server: string, directory?: string) =>
    JSON.stringify([server, directory]);
  const touched = new Set<string>();
  const put = (key: string, next?: MergedEntry) => {
    const previous = entries[key];
    for (const entry of [previous, next]) {
      if (entry) {
        touched.add(partitionKey(entry.sidecarId));
        touched.add(partitionKey(entry.sidecarId, entry.directory));
      }
    }
    const member = (entry: MergedEntry, add: boolean, directory?: string) => {
      const p = partitionKey(entry.sidecarId, directory);
      let partition = partitions.get(p);
      if (!partition) partitions.set(p, partition = { members: new Set() });
      if (add) partition.members.add(entry.id);
      else partition.members.delete(entry.id);
      partition.ids = undefined;
    };
    if (previous && (!next || previous.directory !== next.directory)) {
      member(previous, false, previous.directory);
    }
    if (next && (!previous || previous.directory !== next.directory)) {
      member(next, true, next.directory);
    }
    if (previous && !next) member(previous, false);
    if (next && !previous) member(next, true);
    if (next) entries[key] = next;
    else delete entries[key];
  };
  const ids = (server: string, directory?: string) => {
    const key = partitionKey(server, directory);
    void partitionClock.state.keys[key];
    const partition = partitions.get(key);
    return partition ? partition.ids ??= [...partition.members] : emptyIDs;
  };
  const emptyIDs: readonly string[] = [];
  const state: IndexState = {
    get entries() {
      void clock.state.revision;
      return entries;
    },
  };
  const publish = (changed: Set<string>) => {
    partitionClock.update((draft) => {
      for (const key of touched) draft.keys[key] = (draft.keys[key] ?? 0) + 1;
    });
    touched.clear();
    clock.update((draft) => {
      draft.revision++;
      for (const key of changed) {
        if (entries[key]) draft.keys[key] = (draft.keys[key] ?? 0) + 1;
        else delete draft.keys[key];
      }
    });
  };
  const revisions = new Map<string, number>();
  return {
    state,
    ids,
    partition: (server, directory) =>
      ids(server, directory).map((id) => entries[sessionKey(server, id)]),
    get(sidecarId, sessionID) {
      const key = sessionKey(sidecarId, sessionID);
      void clock.state.keys[key];
      return entries[key];
    },
    subscribe: (listener) => clock.subscribe(() => listener(state)),
    receive(sidecarId: string, frame: IndexFrame): boolean {
      if (!acceptsPatch(revisions.get(sidecarId), frame)) return false;
      const changed = new Set<string>();
      if (frame.t === "index.snapshot") {
        const incoming = new Set(frame.entries.map((e) => e.id));
        const order = new Map<string, Set<string>>();
        for (const id of ids(sidecarId)) {
          if (!incoming.has(id)) {
            const key = sessionKey(sidecarId, id);
            put(key);
            changed.add(key);
          }
        }
        for (const entry of frame.entries) {
          const key = sessionKey(sidecarId, entry.id);
          put(key, { ...structuredClone(entry), sidecarId });
          changed.add(key);
          for (
            const p of [
              partitionKey(sidecarId),
              partitionKey(sidecarId, entry.directory),
            ]
          ) {
            let members = order.get(p);
            if (!members) order.set(p, members = new Set());
            members.add(entry.id);
          }
        }
        // A complete replacement also owns order. Preserve borrowed identities
        // when the order is unchanged, including ordinary warm resnapshots.
        for (const [p, members] of order) {
          const next = [...members], previous = partitions.get(p)!;
          const old = previous.ids ?? [...previous.members];
          if (
            old.length !== next.length || old.some((id, i) => id !== next[i])
          ) partitions.set(p, { members, ids: next });
        }
      } else {for (const op of frame.ops) {
          const key = sessionKey(
            sidecarId,
            op.op === "upsert" ? op.entry.id : op.id,
          );
          if (op.op === "upsert") {
            put(key, { ...structuredClone(op.entry), sidecarId });
          } else if (op.op === "digest") {
            const entry = entries[key];
            if (!entry || op.revision < entry.digest.revision) continue;
            const turns =
              !Object.keys(op.turns.upsert).length && !op.turns.remove.length
                ? entry.digest.turns
                : {
                  ...entry.digest.turns,
                  ...structuredClone(op.turns.upsert),
                };
            for (const id of op.turns.remove) delete turns[id];
            const next = {
              ...entry,
              digest: {
                ...entry.digest,
                ...structuredClone(op.summary),
                revision: op.revision,
                turns,
              },
            };
            if (op.helper === null) delete next.digest.helper;
            else if (op.helper) next.digest.helper = structuredClone(op.helper);
            if (op.deleted) next.deleted = structuredClone(op.deleted);
            else delete next.deleted;
            put(key, next);
          } else if (op.op === "remove") put(key);
          else {
            const unhandled: never = op;
            throw new Error(
              `Unhandled index operation: ${JSON.stringify(unhandled)}`,
            );
          }
          changed.add(key);
        }}
      revisions.set(sidecarId, frame.rev);
      publish(changed);
      return true;
    },
    remove(sidecarId: string): void {
      revisions.delete(sidecarId);
      const changed = new Set<string>();
      for (const id of ids(sidecarId)) {
        const key = sessionKey(sidecarId, id);
        put(key);
        changed.add(key);
      }
      publish(changed);
    },
  };
}
export function projectGroups(
  entries: MergedEntry[],
  sidecarId: string,
): { directory: string; entries: MergedEntry[] }[] {
  const groups = new Map<string, MergedEntry[]>();
  for (const entry of entries) {
    if (entry.sidecarId === sidecarId && !entry.parentID) {
      const list = groups.get(entry.directory) ?? [];
      list.push(entry);
      groups.set(entry.directory, list);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map((
    [directory, entries],
  ) => ({
    directory,
    entries: entries.sort((a, b) =>
      b.timeUpdated - a.timeUpdated || a.id.localeCompare(b.id)
    ),
  }));
}
