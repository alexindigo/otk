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
  subscribe(listener: (state: IndexState) => void): () => void;
  receive(sidecarId: string, frame: IndexFrame): boolean;
  remove(sidecarId: string): void;
}
export function createIndex(factory: StateFactory = createState): ClientIndex {
  const store = factory<
    { entries: Record<string, MergedEntry> }
  >({ entries: {} });
  const { state, update: setState, subscribe } = store;
  const revisions = new Map<string, number>();
  return {
    state,
    subscribe,
    receive(sidecarId: string, frame: IndexFrame): boolean {
      if (!acceptsPatch(revisions.get(sidecarId), frame)) return false;
      setState((draft) => {
        if (frame.t === "index.snapshot") {
          const others = Object.fromEntries(
            Object.entries(draft.entries).filter(([, entry]) =>
              entry.sidecarId !== sidecarId
            ),
          );
          const incoming = Object.fromEntries(
            frame.entries.map((
              entry,
            ) => [sessionKey(sidecarId, entry.id), { ...entry, sidecarId }]),
          );
          store.reconcile(draft.entries, { ...others, ...incoming });
        } else {for (const op of frame.ops) {
            if (op.op === "upsert") {
              draft.entries[sessionKey(sidecarId, op.entry.id)] = {
                ...op.entry,
                sidecarId,
              };
            } else delete draft.entries[sessionKey(sidecarId, op.id)];
          }}
      });
      revisions.set(sidecarId, frame.rev);
      return true;
    },
    remove(sidecarId: string): void {
      revisions.delete(sidecarId);
      setState((draft) => {
        for (const [key, entry] of Object.entries(draft.entries)) {
          if (entry.sidecarId === sidecarId) delete draft.entries[key];
        }
      });
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
