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
  subscribe(listener: (state: IndexState) => void): () => void;
  receive(sidecarId: string, frame: IndexFrame): boolean;
  remove(sidecarId: string): void;
}
export function createIndex(factory: StateFactory = createState): ClientIndex {
  // Data is synchronous and framework-free. The binding publishes only keyed
  // clocks, so deferred painting can never govern action admission.
  const entries: Record<string, MergedEntry> = {};
  const clock = factory({ revision: 0, keys: {} as Record<string, number> });
  const state: IndexState = {
    get entries() {
      void clock.state.revision;
      return entries;
    },
  };
  const publish = (changed: Set<string>) =>
    clock.update((draft) => {
      draft.revision++;
      for (const key of changed) {
        if (entries[key]) draft.keys[key] = (draft.keys[key] ?? 0) + 1;
        else delete draft.keys[key];
      }
    });
  const revisions = new Map<string, number>();
  return {
    state,
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
        for (const [key, entry] of Object.entries(entries)) {
          if (entry.sidecarId === sidecarId) {
            delete entries[key];
            changed.add(key);
          }
        }
        for (const entry of frame.entries) {
          const key = sessionKey(sidecarId, entry.id);
          entries[key] = { ...structuredClone(entry), sidecarId };
          changed.add(key);
        }
      } else {for (const op of frame.ops) {
          const key = sessionKey(
            sidecarId,
            op.op === "upsert" ? op.entry.id : op.id,
          );
          if (op.op === "upsert") {
            entries[key] = { ...structuredClone(op.entry), sidecarId };
          } else if (op.op === "digest") {
            const entry = entries[key];
            if (!entry || op.revision < entry.digest.revision) continue;
            const turns = {
              ...entry.digest.turns,
              ...structuredClone(op.turns.upsert),
            };
            for (const id of op.turns.remove) delete turns[id];
            const next = entries[key] = {
              ...entry,
              digest: {
                ...structuredClone(op.summary),
                revision: op.revision,
                turns,
              },
            };
            if (op.deleted) next.deleted = structuredClone(op.deleted);
            else delete next.deleted;
          } else if (op.op === "remove") delete entries[key];
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
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.sidecarId === sidecarId) {
          delete entries[key];
          changed.add(key);
        }
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
