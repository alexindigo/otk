// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";
import type { IndexEntry, IndexMetadata } from "@otk/protocol";
import type { ContentSession } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";

export interface MergedEntry extends IndexEntry {
  sidecarId: string;
  operationStatus?: import("./inbox.ts").InboxStatus;
}
export interface MergedMetadata extends IndexMetadata {
  sidecarId: string;
  operationStatus?: import("./inbox.ts").InboxStatus;
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
/** Accepted reduced identities, not wire operations or another metadata cache. */
export interface IndexChanges {
  revision: number;
  ids: readonly string[];
  structural: boolean;
  metadata: readonly string[];
}
export interface ClientIndex {
  state: IndexState;
  get(sidecarId: string, sessionID: string): MergedEntry | undefined;
  children(sidecarId: string, sessionID: string): readonly string[];
  ids(sidecarId: string, directory?: string): readonly string[];
  partition(sidecarId: string, directory?: string): MergedEntry[];
  progress(
    sidecarId: string,
    directory: string,
  ): { busy: boolean; announcement: string };
  catalog(sidecarId: string, directory?: string): readonly MergedMetadata[];
  getMetadata(sidecarId: string, sessionID: string): MergedMetadata | undefined;
  changes(sidecarId: string): IndexChanges | undefined;
  subscribe(listener: (state: IndexState) => void): () => void;
  receive(sidecarId: string, frame: IndexFrame): boolean;
  remove(sidecarId: string): void;
}
export function createIndex(factory: StateFactory = createState): ClientIndex {
  // Data is synchronous and framework-free. The binding publishes only keyed
  // clocks, so deferred painting can never govern action admission.
  const entries: Record<string, MergedEntry> = {};
  const children = new Map<string, Set<string>>();
  const clock = factory({ revision: 0, keys: {} as Record<string, number> });
  const partitions = new Map<
    string,
    {
      members: Set<string>;
      ids?: readonly string[];
      catalog?: readonly MergedMetadata[];
      entries?: MergedEntry[];
      digesting?: number;
      progress?: { busy: boolean; announcement: string };
    }
  >();
  const partitionClock = factory({ keys: {} as Record<string, number> });
  const membershipClock = factory({ keys: {} as Record<string, number> });
  const metadataClock = factory({ keys: {} as Record<string, number> });
  const progressClock = factory({ keys: {} as Record<string, number> });
  const metadataValues = new WeakMap<MergedEntry, MergedMetadata>();
  const metadataValue = (entry: MergedEntry): MergedMetadata => {
    let value = metadataValues.get(entry);
    if (!value) {
      const { digest: _, ...metadata } = entry;
      metadataValues.set(entry, value = metadata);
    }
    return value;
  };
  const partitionKey = (server: string, directory?: string) =>
    JSON.stringify([server, directory]);
  const touched = new Set<string>();
  const membershipTouched = new Set<string>(),
    metadataTouched = new Set<string>();
  const metadataChanged = new Set<string>();
  let structural = false;
  const changes = new Map<string, IndexChanges>();
  const put = (key: string, next?: MergedEntry) => {
    const previous = entries[key];
    if (previous?.parentID !== next?.parentID) {
      if (previous?.parentID) {
        const parent = sessionKey(previous.sidecarId, previous.parentID);
        children.get(parent)?.delete(previous.id);
        if (!children.get(parent)?.size) children.delete(parent);
      }
      if (next?.parentID) {
        const parent = sessionKey(next.sidecarId, next.parentID);
        let values = children.get(parent);
        if (!values) children.set(parent, values = new Set());
        values.add(next.id);
      }
    }
    const changedMetadata = !previous || !next ||
      Object.keys({ ...previous, ...next }).some((field) =>
        field !== "digest" &&
        Reflect.get(previous, field) !== Reflect.get(next, field) &&
        JSON.stringify(Reflect.get(previous, field)) !==
          JSON.stringify(Reflect.get(next, field))
      );
    if (changedMetadata) metadataChanged.add(key);
    else if (next && previous) {
      metadataValues.set(next, metadataValue(previous));
    }
    if (
      !previous || !next || previous.parentID !== next.parentID ||
      previous.directory !== next.directory ||
      previous.projectID !== next.projectID ||
      previous.timeCreated !== next.timeCreated ||
      previous.archived !== next.archived ||
      !!previous.deleted !== !!next.deleted
    ) structural = true;
    for (const entry of [previous, next]) {
      if (entry) {
        touched.add(partitionKey(entry.sidecarId));
        touched.add(partitionKey(entry.sidecarId, entry.directory));
        if (changedMetadata) {
          metadataTouched.add(partitionKey(entry.sidecarId));
          metadataTouched.add(partitionKey(entry.sidecarId, entry.directory));
        }
      }
    }
    const member = (entry: MergedEntry, add: boolean, directory?: string) => {
      const p = partitionKey(entry.sidecarId, directory);
      let partition = partitions.get(p);
      if (!partition) partitions.set(p, partition = { members: new Set() });
      if (add) partition.members.add(entry.id);
      else partition.members.delete(entry.id);
      partition.ids = undefined;
      partition.catalog = undefined;
      membershipTouched.add(p);
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
    for (const value of [previous, next]) {
      if (!value) continue;
      const p = partitionKey(value.sidecarId, value.directory);
      const partition = partitions.get(p)!;
      partition.digesting = (partition.digesting ?? 0) +
        (value.digest.state === "digesting" || value.digest.refreshing
          ? (value === next ? 1 : -1)
          : 0);
    }
  };
  const members = (server: string, directory?: string) => {
    const key = partitionKey(server, directory);
    const partition = partitions.get(key);
    return partition ? partition.ids ??= [...partition.members] : emptyIDs;
  };
  const ids = (server: string, directory?: string) => {
    void membershipClock.state.keys[partitionKey(server, directory)];
    return members(server, directory);
  };
  const emptyIDs: readonly string[] = [];
  const state: IndexState = {
    get entries() {
      void clock.state.revision;
      return entries;
    },
  };
  const publish = (changed: Set<string>) => {
    const progressChanged: string[] = [];
    for (const key of touched) {
      const partition = partitions.get(key);
      if (!partition) continue;
      partition.entries = undefined;
      const busy = !!partition.digesting;
      const announcement = partition.members.size && !busy
        ? "Session summaries updated."
        : "";
      if (
        partition.progress?.busy !== busy ||
        partition.progress.announcement !== announcement
      ) {
        partition.progress = { busy, announcement };
        progressChanged.push(key);
      }
    }
    if (progressChanged.length) {
      progressClock.update((draft) => {
        for (const key of progressChanged) {
          draft.keys[key] = (draft.keys[key] ?? 0) + 1;
        }
      });
    }
    partitionClock.update((draft) => {
      for (const key of touched) draft.keys[key] = (draft.keys[key] ?? 0) + 1;
    });
    touched.clear();
    membershipClock.update((draft) => {
      for (const key of membershipTouched) {
        draft.keys[key] = (draft.keys[key] ?? 0) + 1;
      }
    });
    membershipTouched.clear();
    metadataClock.update((draft) => {
      for (const key of metadataTouched) {
        const partition = partitions.get(key);
        if (partition) partition.catalog = undefined;
        draft.keys[key] = (draft.keys[key] ?? 0) + 1;
      }
      for (const key of metadataChanged) {
        if (entries[key]) draft.keys[key] = (draft.keys[key] ?? 0) + 1;
        else delete draft.keys[key];
      }
    });
    metadataTouched.clear();
    metadataChanged.clear();
    clock.update((draft) => {
      draft.revision++;
      for (const key of changed) {
        if (entries[key]) draft.keys[key] = (draft.keys[key] ?? 0) + 1;
        else delete draft.keys[key];
      }
    });
  };
  const revisions = new Map<string, number>();
  const epochs = new Map<string, number>();
  return {
    state,
    ids,
    children: (server, id) => [...(children.get(sessionKey(server, id)) ?? [])],
    changes: (server) => changes.get(server),
    partition: (server, directory) => {
      const key = partitionKey(server, directory);
      void partitionClock.state.keys[key];
      const partition = partitions.get(key);
      return partition
        ? partition.entries ??= members(server, directory).map((id) =>
          entries[sessionKey(server, id)]
        )
        : [];
    },
    progress(server, directory) {
      const key = partitionKey(server, directory);
      void progressClock.state.keys[key];
      return partitions.get(key)?.progress ?? { busy: false, announcement: "" };
    },
    catalog: (server, directory) => {
      const key = partitionKey(server, directory);
      void metadataClock.state.keys[key];
      const partition = partitions.get(key);
      return partition
        ? partition.catalog ??= members(server, directory).map((id) =>
          metadataValue(entries[sessionKey(server, id)])
        )
        : [];
    },
    getMetadata(server, id) {
      const key = sessionKey(server, id);
      void metadataClock.state.keys[key];
      return entries[key] && metadataValue(entries[key]);
    },
    get(sidecarId, sessionID) {
      const key = sessionKey(sidecarId, sessionID);
      void clock.state.keys[key];
      return entries[key];
    },
    subscribe: (listener) => clock.subscribe(() => listener(state)),
    receive(sidecarId: string, frame: IndexFrame): boolean {
      const epoch = epochs.get(sidecarId);
      if (
        frame.epoch !== undefined && epoch !== undefined && frame.epoch < epoch
      ) return false;
      const replacement = frame.t === "index.patch" &&
        frame.from !== undefined &&
        frame.epoch !== undefined && frame.epoch !== epoch &&
        frame.from <= (revisions.get(sidecarId) ?? 0) &&
        frame.rev === frame.from + frame.ops.length;
      if (!replacement && !acceptsPatch(revisions.get(sidecarId), frame)) {
        return false;
      }
      if (frame.epoch !== undefined) epochs.set(sidecarId, frame.epoch);
      structural = false;
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
          ) {
            partitions.set(p, {
              ...previous,
              members,
              ids: next,
              catalog: undefined,
              entries: undefined,
            });
            membershipTouched.add(p);
            structural = true;
          }
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
                ...(entry.digest.refreshing === undefined &&
                    op.summary.refreshing === undefined
                  ? {}
                  : {
                    refreshing: op.summary.refreshing ??
                      op.summary.state === "digesting",
                  }),
                ...(entry.digest.stale === undefined &&
                    op.summary.stale === undefined
                  ? {}
                  : { stale: op.summary.stale ?? false }),
                ...(entry.digest.error === undefined
                  ? {}
                  : { error: op.summary.error }),
                revision: op.revision,
                turns,
              },
            };
            if (op.helper === null) delete next.digest.helper;
            else if (op.helper) next.digest.helper = structuredClone(op.helper);
            if (op.deleted) next.deleted = structuredClone(op.deleted);
            else delete next.deleted;
            put(key, next);
          } else if (op.op === "remove" || op.op === "evict") put(key);
          else {
            const unhandled: never = op;
            throw new Error(
              `Unhandled index operation: ${JSON.stringify(unhandled)}`,
            );
          }
          changed.add(key);
        }}
      revisions.set(sidecarId, frame.rev);
      changes.set(sidecarId, {
        revision: frame.rev,
        ids: [...changed].map((key) => key.slice(sidecarId.length + 1)),
        structural,
        metadata: [...metadataChanged].map((key) =>
          key.slice(sidecarId.length + 1)
        ),
      });
      publish(changed);
      return true;
    },
    remove(sidecarId: string): void {
      revisions.delete(sidecarId);
      epochs.delete(sidecarId);
      changes.delete(sidecarId);
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
