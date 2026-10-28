// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexEntry,
  sessionAncestors,
  type SessionLookup,
  type TaskRecord,
} from "@otk/protocol";
import type { Selection } from "./session.ts";

export function sessionFamily(id: string, lookup: SessionLookup): string[] {
  return [id, ...sessionAncestors(id, lookup)];
}
export function familyTask(
  tasks: readonly TaskRecord[],
  family: readonly string[],
  directory?: string,
): TaskRecord | undefined {
  for (const id of family) {
    const task = tasks.find((task) =>
      (directory === undefined || task.directory === directory) &&
      task.sessions.includes(id)
    );
    if (task) return task;
  }
}
export function familySelection(
  selection: Selection,
  lookup: SessionLookup,
): Selection {
  const ancestors = sessionAncestors(selection.sessionID, lookup);
  return ancestors.length
    ? { ...selection, rootID: ancestors.at(-1) }
    : selection;
}

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
  const parents = new Map(sessions.map((e) => [e.id, e.parentID]));
  const ownership = new Map(explicit);
  const groupFor = (entry: IndexEntry): string => {
    const path: string[] = [], seen = new Set<string>();
    let id: string | undefined = entry.id;
    while (id && byID.has(id) && !ownership.has(id) && !seen.has(id)) {
      path.push(id);
      seen.add(id);
      id = parents.get(id);
    }
    const group = id ? ownership.get(id) ?? "" : "";
    for (const key of path) ownership.set(key, group);
    return group;
  };
  const buckets = new Map<string, IndexEntry[]>();
  for (const session of sessions) {
    const id = groupFor(session);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(session);
  }
  const needle = query.trim().toLocaleLowerCase();
  const taskByID = new Map(ordered.map((t) => [t.id, t]));
  return [...ordered.map((t) => ({ id: t.id, title: t.name })), {
    id: "",
    title: "Not in a task",
  }].map((group) => {
    const members = buckets.get(group.id) ?? [];
    const ids = new Set(members.map((e) => e.id));
    const children = new Map<string, IndexEntry[]>();
    for (const entry of members) {
      const parent = parents.get(entry.id);
      if (!parent || !ids.has(parent)) continue;
      const list = children.get(parent) ?? [];
      list.push(entry);
      children.set(parent, list);
    }
    const visible = new Set<string>();
    for (const entry of members) {
      if (needle && !entry.title.toLocaleLowerCase().includes(needle)) continue;
      let current: IndexEntry | undefined = entry;
      while (current && ids.has(current.id) && !visible.has(current.id)) {
        visible.add(current.id);
        current = byID.get(parents.get(current.id) ?? "");
      }
    }
    const rows: SessionTreeRow[] = [], visited = new Set<string>();
    const walk = (entry: IndexEntry) => {
      const stack: SessionTreeRow[] = [{ session: entry, depth: 0 }];
      while (stack.length) {
        const row = stack.pop()!, id = row.session.id;
        if (visited.has(id) || !visible.has(id)) continue;
        visited.add(id);
        rows.push(row);
        const next = children.get(id) ?? [];
        for (let i = next.length - 1; i >= 0; i--) {
          stack.push({ session: next[i], depth: row.depth + 1, parentID: id });
        }
      }
    };
    const roots = new Map(
      members.filter((e) => !ids.has(parents.get(e.id) ?? "")).map(
        (e) => [e.id, e],
      ),
    );
    for (const id of taskByID.get(group.id)?.sessions ?? []) {
      const entry = roots.get(id);
      if (entry) {
        walk(entry);
        roots.delete(id);
      }
    }
    for (const entry of roots.values()) walk(entry);
    for (const entry of members) walk(entry);
    return { ...group, rows };
  }).filter((group) => !needle || group.rows.length > 0);
}

export type SessionListRow =
  | { key: string; kind: "heading"; group: string; title: string }
  | {
    key: string;
    kind: "session";
    group: string;
    title: string;
    id: string;
    depth: number;
    parentID?: string;
    position: number;
    size: number;
  };

/** Structural cache only: live status, attention and summaries stay in ClientIndex. */
export function createSessionTree(): {
  rows(
    entries: readonly IndexEntry[],
    tasks: readonly TaskRecord[],
    directory: string,
    query?: string,
  ): SessionListRow[];
} {
  let signature = "", result: SessionListRow[] = [];
  return {
    rows(entries, tasks, directory, query = "") {
      const next = JSON.stringify([
        directory,
        query.trim().toLocaleLowerCase(),
        entries.map((e) => [e.id, e.parentID, e.directory, e.title]),
        tasks.map((t) => [t.id, t.name, t.directory, t.order, t.sessions]),
      ]);
      if (signature === next) return result;
      signature = next;
      const groups = sessionTree(entries, tasks, directory, query);
      const size = groups.reduce((sum, group) => sum + group.rows.length, 0);
      let position = 0;
      result = groups.flatMap(
        (group) => [
          {
            key: `heading:${group.id}`,
            kind: "heading" as const,
            group: group.id,
            title: group.title,
          },
          ...group.rows.map((row) => ({
            key: row.session.id,
            kind: "session" as const,
            group: group.id,
            title: group.title,
            id: row.session.id,
            depth: row.depth,
            parentID: row.parentID,
            position: ++position,
            size,
          })),
        ],
      );
      return result;
    },
  };
}
