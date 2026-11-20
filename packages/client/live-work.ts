// SPDX-License-Identifier: LGPL-3.0-only
import {
  derivedValue,
  type InboxSnapshot,
  type IndexEntry,
  type IndexMetadata,
  type Message,
} from "@otk/protocol";
import type { ClientTabs } from "./tabs.ts";
import { createState } from "./state.ts";
import type { TaskCrumb } from "./task-breadcrumbs.ts";

/** Native ancestry and positive current work, not task grouping or lamp priority. */
export function runningDescendants(
  root: string | undefined,
  entries: readonly IndexMetadata[],
  connected = true,
): TaskCrumb[] {
  if (!root || !connected) return [];
  const children = new Map<string, IndexMetadata[]>();
  for (const entry of entries) {
    if (!entry.parentID) continue;
    const rows = children.get(entry.parentID) ?? [];
    rows.push(entry);
    children.set(entry.parentID, rows);
  }
  const visited = new Set([root]);
  const stack = (children.get(root) ?? []).map((entry) => ({
    entry,
    depth: 1,
  }));
  const result: TaskCrumb[] = [];
  while (stack.length) {
    const { entry, depth } = stack.pop()!;
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    if (
      !entry.deleted && entry.activity?.work?.fresh &&
      entry.activity.work.keys.length
    ) {
      result.push({ id: entry.id, helper: true, depth });
    }
    for (const child of children.get(entry.id) ?? []) {
      stack.push({ entry: child, depth: depth + 1 });
    }
  }
  const byID = new Map(entries.map((entry) => [entry.id, entry]));
  return result.toSorted((a, b) =>
    (byID.get(a.id)?.timeCreated ?? 0) - (byID.get(b.id)?.timeCreated ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

export interface RunningWork {
  id: string;
  kind: "helper" | "shell";
  label: string;
  title: string;
  sessionID: string;
  startedAt?: number;
}
export interface LiveWorkOwner {
  items(): readonly RunningWork[];
  canStop(id: string): boolean;
  stopping(id: string): boolean;
  stop(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
/** Stop admission belongs to the work lifetime, not an open popover. */
export function createLiveWork(input: {
  items(): readonly RunningWork[];
  stopHelper?(): ((id: string) => Promise<void>) | undefined;
}): LiveWorkOwner {
  const state = createState({ pending: new Set<string>() });
  const pending = new Map<string, Promise<void>>();
  const item = (id: string) => input.items().find((item) => item.id === id);
  return {
    items: input.items,
    canStop: (id) => item(id)?.kind === "helper" && !!input.stopHelper?.(),
    stopping: (id) => state.state.pending.has(id),
    subscribe: (listener) => state.subscribe(listener),
    stop(id) {
      const admitted = pending.get(id);
      if (admitted) return admitted;
      const current = item(id), stop = input.stopHelper?.();
      if (current?.kind !== "helper" || !stop) return Promise.resolve();
      const work = Promise.resolve().then(() => stop(current.sessionID))
        .finally(() => {
          pending.delete(id);
          state.update((s) => s.pending.delete(id));
        });
      pending.set(id, work);
      state.update((s) => s.pending.add(id));
      return work;
    },
  };
}

/** Borrow the shared family and native scalar inventory, never transcript pages. */
export function runningWork(input: {
  tabs: Pick<ClientTabs, "working">;
  inbox: InboxSnapshot;
  sessionID: string;
  entry(id: string): IndexEntry | undefined;
  /** Compatibility input, deliberately not consulted for live inventory. */
  messages?: readonly Message[];
  connected: boolean;
}): RunningWork[] {
  if (!input.connected) return [];
  const items: RunningWork[] = [];
  for (const crumb of input.tabs.working()) {
    const entry = input.entry(crumb.id);
    if (!entry) continue;
    const work = entry.activity?.work;
    items.push({
      id: `helper/${entry.id}`,
      kind: "helper",
      label: derivedValue(entry.digest.last)?.agent ?? "Helper",
      title: entry.title,
      sessionID: entry.id,
      startedAt: work?.fresh
        ? work.items?.find((item) =>
          item.kind === "execution" && work.keys.includes(item.id)
        )?.startedAt
        : undefined,
    });
  }
  const current = input.entry(input.sessionID);
  const work = current?.activity?.work;
  if (!work?.fresh) return items;
  const seen = new Set<string>();
  for (const item of work.items ?? []) {
    if (
      item.kind !== "shell" || !work.keys.includes(item.id) || seen.has(item.id)
    ) continue;
    seen.add(item.id);
    items.push({
      ...item,
      id: `shell/${item.id}`,
      kind: "shell",
      sessionID: input.sessionID,
    });
  }
  return items;
}

export function runningWorkLabel(items: readonly RunningWork[]): string {
  return (["helper", "shell"] as const).flatMap((kind) => {
    const count = items.filter((item) => item.kind === kind).length;
    const label = kind === "helper" ? "subagent" : "shell";
    return count ? [`${count} ${label}${count === 1 ? "" : "s"}`] : [];
  }).join(", ");
}

/** Compact elapsed clock for live-work rows; the view supplies the live clock. */
export function runningWorkElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
