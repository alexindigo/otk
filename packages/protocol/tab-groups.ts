// SPDX-License-Identifier: LGPL-3.0-only
import {
  projectSessionHierarchy,
  type SessionHierarchyNode,
} from "./session-hierarchy.ts";
import type { SessionStructure } from "./session-list.ts";
import type { TaskRecord } from "./inbox.ts";

export interface TabGroup {
  kind: "task" | "session";
  id: string;
  /** Explicit members, or the phantom's own session. */
  roots: string[];
  /** Complete ordered membership, independent of activity and visibility. */
  members: string[];
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

/** One task-identity partition for every consumer. Only a proven human root
 * establishes a session group. Activity, selection and explicit helper records
 * cannot cut that group; they affect visibility only. */
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
  const rootFor = (id: string) => hierarchy.get(id)?.rootID;
  const taskByID = new Map(tasks.map((task) => [task.id, task]));
  const owners = new Map<string, TabGroup>();
  const taskOfRoot = (root: string) => {
    if (byID.has(root)) {
      return taskByID.get(taskHierarchy.get(root)?.taskID ?? "");
    }
    const reserved = owners.get(root);
    if (reserved?.kind === "task") return taskByID.get(reserved.id);
  };
  const projectFor = (id: string) => {
    // A checkout is a view of the partition. When following parents, its
    // inherited scope comes from the same human root that owns the subtree.
    const root = options.followParent ? rootFor(id) : undefined;
    const inherited = root
      ? taskOfRoot(root)?.directory ?? hierarchy.get(root)?.projectDirectory
      : undefined;
    return scopedDirectory(inherited) ?? hierarchy.get(id)?.projectDirectory ??
      scopedDirectory(byID.get(id)?.directory);
  };
  const local = (id: string) =>
    options.directory === undefined ||
    scopes.has(byID.get(id)?.directory) ||
    projectFor(id) === options.directory;
  const groups = new Map<string, TabGroup>();
  const group = (kind: TabGroup["kind"], id: string): TabGroup => {
    const key = `${kind}/${id}`;
    let value = groups.get(key);
    if (!value) {
      value = {
        kind,
        id,
        roots: [],
        members: [],
      };
      groups.set(key, value);
    }
    return value;
  };
  // Keep empty tasks and explicit identities whose metadata has not arrived.
  for (const task of tasks) {
    const known = task.sessions.flatMap((id) =>
      byID.has(id) ? [byID.get(id)!] : []
    );
    if (known.length && known.every((entry) => entry.parentID)) continue;
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
    let id = entry.id, owner: TabGroup | undefined;
    while (true) {
      const known = owners.get(id);
      if (known) {
        owner = known;
        break;
      }
      const task = taskByID.get(taskHierarchy.get(id)?.taskID ?? "");
      if (task && groups.has(`task/${task.id}`) && !byID.get(id)?.parentID) {
        owner = group("task", task.id);
        break;
      }
      const cycle = positions.get(id);
      if (cycle !== undefined) {
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      const parent = localParent(id);
      if (!parent) {
        const rootID = rootFor(id) ??
          (!byID.get(id)?.parentID ? id : undefined);
        if (rootID && byID.has(rootID) && !byID.get(rootID)!.parentID) {
          const rootTask = taskOfRoot(rootID);
          owner = rootTask &&
              groups.has(`task/${rootTask.id}`)
            ? group("task", rootTask.id)
            : group("session", rootID);
        }
        break;
      }
      id = parent;
    }
    if (!owner) continue;
    if (local(id)) owners.set(id, owner);
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
      : ids.has(value.id)
      ? [value.id]
      : [];
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
        for (const child of [...children.get(id) ?? []].reverse()) {
          if (!explicit.has(child)) stack.push(child);
        }
      }
    };
    for (const id of value.roots) walk(id);
    for (const id of members) {
      if (!ids.has(byID.get(id)?.parentID ?? "")) walk(id);
    }
    for (const id of members) walk(id);
  }
  return { owners, groups: [...groups.values()] };
}
