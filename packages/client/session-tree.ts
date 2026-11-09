// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexMetadata,
  sessionAncestors,
  type SessionListRow,
  type SessionLookup,
  type SessionStructure,
  type TaskRecord,
} from "@otk/protocol";
export type { SessionListRow } from "@otk/protocol";

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
export function familySelection<T extends { sessionID: string }>(
  selection: T,
  lookup: SessionLookup,
): T {
  const ancestors = sessionAncestors(selection.sessionID, lookup);
  return ancestors.length
    ? { ...selection, rootID: ancestors.at(-1) }
    : selection;
}

export interface SessionTreeRow<T extends SessionStructure = IndexMetadata> {
  session: T;
  depth: number;
  parentID?: string;
}
export interface SessionTreeGroup<T extends SessionStructure = IndexMetadata> {
  id: string;
  title: string;
  rows: SessionTreeRow<T>[];
}
/** Project-local hierarchy. Explicit membership wins; otherwise helpers inherit
 * their nearest grouped ancestor. Missing parents and cycles cannot hide rows.
 * Search keeps the ancestry of matching titles for orientation. */
export function sessionTree<T extends SessionStructure>(
  entries: readonly T[],
  tasks: readonly TaskRecord[],
  directory: string,
  query = "",
  directories: readonly string[] = [directory],
): SessionTreeGroup<T>[] {
  const scopes = new Set(directories);
  const sessions = entries.filter((e) => scopes.has(e.directory));
  const byID = new Map(sessions.map((e) => [e.id, e]));
  const ordered = tasks.filter((t) => scopes.has(t.directory))
    .sort((a, b) => a.order - b.order);
  const explicit = new Map<string, string>();
  for (const task of ordered) {
    for (const id of task.sessions) {
      if (!explicit.has(id)) explicit.set(id, task.id);
    }
  }
  const parents = new Map(sessions.map((e) => [e.id, e.parentID]));
  const ownership = new Map(explicit);
  const groupFor = (entry: T): string => {
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
  const buckets = new Map<string, T[]>();
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
    const children = new Map<string, T[]>();
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
      let current: T | undefined = entry;
      while (current && ids.has(current.id) && !visible.has(current.id)) {
        visible.add(current.id);
        current = byID.get(parents.get(current.id) ?? "");
      }
    }
    const rows: SessionTreeRow<T>[] = [], visited = new Set<string>();
    const walk = (entry: T) => {
      const stack: SessionTreeRow<T>[] = [{ session: entry, depth: 0 }];
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

/** Structural cache only: live status, attention and summaries stay in ClientIndex. */
export function createSessionTree(): {
  rows(
    entries: readonly SessionStructure[],
    tasks: readonly TaskRecord[],
    directory: string,
    query?: string,
    directories?: readonly string[],
  ): SessionListRow[];
} {
  let previousEntries: readonly SessionStructure[] | undefined;
  let previousTasks: readonly TaskRecord[] | undefined;
  let previousDirectory = "", previousQuery = "", result: SessionListRow[] = [];
  let previousScopes = "";
  return {
    rows(entries, tasks, directory, query = "", directories = [directory]) {
      const scopes = JSON.stringify(directories);
      const needle = query.trim().toLocaleLowerCase();
      const sameEntries = entries === previousEntries ||
        (!!previousEntries && entries.length === previousEntries.length &&
          entries.every((entry, i) => {
            const previous = previousEntries![i];
            return entry.id === previous.id &&
              entry.directory === previous.directory &&
              entry.parentID === previous.parentID &&
              entry.title === previous.title;
          }));
      const sameTasks = tasks === previousTasks ||
        (!!previousTasks && tasks.length === previousTasks.length &&
          tasks.every((task, i) => {
            const previous = previousTasks![i];
            return task.id === previous.id && task.name === previous.name &&
              task.directory === previous.directory &&
              task.order === previous.order &&
              task.sessions.length === previous.sessions.length &&
              task.sessions.every((id, n) => id === previous.sessions[n]);
          }));
      if (
        sameEntries && sameTasks && directory === previousDirectory &&
        needle === previousQuery && scopes === previousScopes
      ) return result;
      previousEntries = entries;
      previousTasks = tasks;
      previousDirectory = directory;
      previousQuery = needle;
      previousScopes = scopes;
      const groups = sessionTree(entries, tasks, directory, query, directories);
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
