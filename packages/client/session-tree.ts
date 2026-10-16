// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, TaskRecord } from "@otk/protocol";

export interface SessionTreeRow {
  session: IndexEntry;
  depth: number;
  parentID?: string;
}
export interface SessionTreeGroup {
  id: string;
  title: string;
  rows: SessionTreeRow[];
}
/** Project-local hierarchy. Explicit membership wins; otherwise helpers inherit
 * their nearest grouped ancestor. Missing parents and cycles cannot hide rows.
 * Search keeps the ancestry of matching titles for orientation. */
export function sessionTree(
  entries: readonly IndexEntry[],
  tasks: readonly TaskRecord[],
  directory: string,
  query = "",
): SessionTreeGroup[] {
  const sessions = entries.filter((e) => e.directory === directory);
  const byID = new Map(sessions.map((e) => [e.id, e]));
  const ordered = tasks.filter((t) => t.directory === directory)
    .toSorted((a, b) => a.order - b.order);
  const explicit = new Map<string, string>();
  for (const task of ordered) {
    for (const id of task.sessions) {
      if (!explicit.has(id)) explicit.set(id, task.id);
    }
  }
  const groupFor = (entry: IndexEntry): string => {
    const seen = new Set<string>();
    let current: IndexEntry | undefined = entry;
    while (current && !seen.has(current.id)) {
      if (explicit.has(current.id)) return explicit.get(current.id)!;
      seen.add(current.id);
      current = current.parentID ? byID.get(current.parentID) : undefined;
    }
    return "";
  };
  const buckets = new Map<string, IndexEntry[]>();
  for (const session of sessions) {
    const id = groupFor(session);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(session);
  }
  const needle = query.trim().toLocaleLowerCase();
  return [...ordered.map((t) => ({ id: t.id, title: t.name })), {
    id: "",
    title: "Not in a task",
  }].map((group) => {
    const members = buckets.get(group.id) ?? [];
    const ids = new Set(members.map((e) => e.id));
    const visible = new Set<string>();
    for (const entry of members) {
      if (needle && !entry.title.toLocaleLowerCase().includes(needle)) continue;
      let current: IndexEntry | undefined = entry;
      while (current && ids.has(current.id) && !visible.has(current.id)) {
        visible.add(current.id);
        current = current.parentID ? byID.get(current.parentID) : undefined;
      }
    }
    const rows: SessionTreeRow[] = [], visited = new Set<string>();
    const walk = (entry: IndexEntry, depth: number, parentID?: string) => {
      if (visited.has(entry.id) || !visible.has(entry.id)) return;
      visited.add(entry.id);
      rows.push({ session: entry, depth, ...(parentID ? { parentID } : {}) });
      for (const child of members) {
        if (child.parentID === entry.id) walk(child, depth + 1, entry.id);
      }
    };
    const task = ordered.find((t) => t.id === group.id);
    const rank = (entry: IndexEntry) => {
      const at = task?.sessions.indexOf(entry.id) ?? -1;
      return at < 0 ? Infinity : at;
    };
    for (const entry of members.toSorted((a, b) => rank(a) - rank(b))) {
      if (!entry.parentID || !ids.has(entry.parentID)) walk(entry, 0);
    }
    for (const entry of members) walk(entry, 0);
    return { ...group, rows };
  }).filter((group) => !needle || group.rows.length > 0);
}
