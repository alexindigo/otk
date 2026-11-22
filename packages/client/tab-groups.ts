// SPDX-License-Identifier: LGPL-3.0-only
import {
  projectSessionHierarchy,
  sessionAncestors,
  type SessionHierarchyNode,
  type SessionStructure,
  type TaskRecord,
} from "@otk/protocol";

export interface TabGroup {
  kind: "task" | "session";
  id: string;
  /** Explicit members, or the phantom's own session. */
  roots: string[];
  /** Complete ordered membership, independent of activity and visibility. */
  members: string[];
  /** Orientation only: these identities are never group members. */
  ancestorLinks: string[];
}
export interface TabGroups {
  owners: ReadonlyMap<string, TabGroup>;
  groups: readonly TabGroup[];
}

/** Independently published nodes keep their own compatible evidence. Both tabs
 * and standalone crumbs borrow this resolved view, including partial catalogs. */
export function resolveTabHierarchy(
  entries: readonly SessionStructure[],
  tasks: readonly TaskRecord[],
  options: {
    followParent?: boolean;
    project?(directory: string, repoID?: string): string;
    hierarchy?: ReadonlyMap<string, SessionHierarchyNode>;
  } = {},
): ReadonlyMap<string, SessionHierarchyNode> {
  const followParent = options.followParent ?? false;
  const node = (entry: SessionStructure) =>
    options.hierarchy?.get(entry.id) ?? entry.hierarchy;
  const projected =
    entries.every((entry) => node(entry)?.followParent === followParent)
      ? undefined
      : projectSessionHierarchy(entries, tasks, {
        followParent,
        project: options.project,
      });
  return new Map(
    entries.map((entry) => [
      entry.id,
      node(entry)?.followParent === followParent
        ? node(entry)!
        : projected!.get(entry.id)!,
    ]),
  );
}

/** One presentation partition for every consumer. Native ancestry establishes
 * inheritance, never membership across another task or an independent phantom.
 * Retained phantoms keep their identity until selection leaves, even when quiet. */
export function projectTabGroups(
  entries: readonly SessionStructure[],
  tasks: readonly TaskRecord[],
  options: {
    hierarchy?: ReadonlyMap<string, SessionHierarchyNode>;
    mandatory?: ReadonlySet<string>;
    retained?: ReadonlySet<string>;
    followParent?: boolean;
    directory?: string;
    directories?: readonly string[];
  } = {},
): TabGroups {
  // Borrow each structural parent once, including observable/getter-backed
  // catalogs. Both neutral projections and ordering walk this one snapshot.
  const sessions = entries.map((entry) => ({
    id: entry.id,
    parentID: entry.parentID,
    directory: entry.directory,
    hierarchy: entry.hierarchy,
  }));
  const scopes = new Set(options.directories ?? [options.directory]);
  const hierarchy = options.hierarchy ??
    projectSessionHierarchy(sessions, tasks, {
      followParent: options.followParent,
      project: (directory) =>
        scopes.has(directory) ? options.directory! : directory,
    });
  // Inbox membership and wire hierarchy publish independently. Resolve current
  // explicit ownership through the neutral projector, so a stale taskID cannot
  // duplicate a promoted member or keep a removed member in the old task.
  const taskHierarchy = options.hierarchy
    ? projectSessionHierarchy(sessions, tasks, {
      followParent: options.followParent ??
        sessions[0]?.hierarchy?.followParent,
      project: (directory) =>
        scopes.has(directory) ? options.directory! : directory,
    })
    : hierarchy;
  const byID = new Map(sessions.map((entry) => [entry.id, entry]));
  const scopedDirectory = (directory: string | undefined) =>
    scopes.has(directory) ? options.directory ?? directory : directory;
  const projectFor = (id: string) =>
    hierarchy.get(id)?.projectDirectory ??
      scopedDirectory(byID.get(id)?.directory);
  const local = (id: string) =>
    options.directory === undefined ||
    scopes.has(byID.get(id)?.directory) ||
    projectFor(id) === options.directory;
  const taskByID = new Map(tasks.map((task) => [task.id, task]));
  const groups = new Map<string, TabGroup>();
  const group = (kind: TabGroup["kind"], id: string): TabGroup => {
    const key = `${kind}/${id}`;
    let value = groups.get(key);
    if (!value) {
      value = { kind, id, roots: [], members: [], ancestorLinks: [] };
      groups.set(key, value);
    }
    return value;
  };
  // Keep empty tasks and explicit identities whose metadata has not arrived.
  const owners = new Map<string, TabGroup>();
  for (const task of tasks) {
    const value = group("task", task.id);
    for (const id of task.sessions) {
      if (
        !byID.has(id) &&
        (options.directory === undefined || scopes.has(task.directory))
      ) {
        if (!owners.has(id)) owners.set(id, value);
      }
    }
  }
  const localParent = (id: string) => {
    const parent = byID.get(id)?.parentID;
    if (!parent) return undefined;
    if (!byID.has(parent)) {
      const reserved = owners.get(parent);
      const directory = reserved?.kind === "task"
        ? taskByID.get(reserved.id)?.directory
        : undefined;
      return reserved &&
          (options.followParent ||
            scopedDirectory(directory) === projectFor(id))
        ? parent
        : undefined;
    }
    return local(parent) && projectFor(parent) === projectFor(id)
      ? parent
      : undefined;
  };
  for (const entry of sessions) {
    if (!local(entry.id) || owners.has(entry.id)) continue;
    const path: string[] = [], positions = new Map<string, number>();
    let id = entry.id, owner: TabGroup;
    while (true) {
      const known = owners.get(id);
      if (known) {
        owner = known;
        break;
      }
      const task = taskByID.get(taskHierarchy.get(id)?.taskID ?? "");
      if (task) {
        owner = group("task", task.id);
        break;
      }
      const cycle = positions.get(id);
      if (cycle !== undefined) {
        owner = group("session", path.slice(cycle).sort()[0]);
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      const parent = localParent(id);
      if (options.mandatory?.has(id) || options.retained?.has(id) || !parent) {
        owner = group("session", id);
        break;
      }
      id = parent;
    }
    owners.set(id, owner);
    for (const member of path) owners.set(member, owner);
  }
  const buckets = new Map<TabGroup, string[]>();
  for (const [id, owner] of owners) {
    const members = buckets.get(owner) ?? [];
    members.push(id);
    buckets.set(owner, members);
  }
  for (const value of groups.values()) {
    const members = buckets.get(value) ?? [], ids = new Set(members);
    value.roots = value.kind === "task"
      ? taskByID.get(value.id)!.sessions.filter((id) => ids.has(id))
      : [value.id];
    const children = new Map<string, string[]>();
    for (const id of members) {
      const parent = byID.get(id)?.parentID;
      if (!parent || !ids.has(parent)) continue;
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
    const visited = new Set<string>(), explicit = new Set(value.roots);
    const walk = (root: string) => {
      const stack = [root];
      while (stack.length) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        value.members.push(id);
        for (const child of (children.get(id) ?? []).toReversed()) {
          if (!explicit.has(child)) stack.push(child);
        }
      }
    };
    for (const id of value.roots) walk(id);
    for (const id of members) {
      if (!ids.has(byID.get(id)?.parentID ?? "")) walk(id);
    }
    for (const id of members) walk(id);
    const links = new Set<string>();
    for (const id of value.members) {
      if (!explicit.has(id) && ids.has(byID.get(id)?.parentID ?? "")) continue;
      for (
        const ancestor of sessionAncestors(id, (key) => byID.get(key))
          .toReversed()
      ) {
        if (!ids.has(ancestor) && byID.has(ancestor)) links.add(ancestor);
      }
    }
    value.ancestorLinks = [...links];
  }
  return { owners, groups: [...groups.values()] };
}
