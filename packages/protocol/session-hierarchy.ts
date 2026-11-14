// SPDX-License-Identifier: LGPL-3.0-only
import type { TaskRecord } from "./inbox.ts";

/** Native family identity and checkout-local presentation are different facts. */
export interface SessionHierarchyNode {
  familyID: string;
  rootID?: string;
  ancestry: "complete" | "unresolved" | "cyclic";
  anchorID: string;
  projectDirectory: string;
  taskID?: string;
  taskDirectory?: string;
  mandatory: boolean;
  followParent: boolean;
}
export interface HierarchySession {
  id: string;
  directory: string;
  parentID?: string;
  projectID?: string;
  hierarchy?: SessionHierarchyNode;
}

/** Neutral projection machinery, also usable by standalone snapshot consumers.
 * The application supplies identity, task and supervision facts. No native reads,
 * storage, UI state or second activity interpretation belongs here. */
export function projectSessionHierarchy(
  entries: readonly HierarchySession[],
  tasks: readonly TaskRecord[],
  options: {
    project?(directory: string, repoID?: string): string;
    followParent?: boolean;
    mandatory?(id: string): boolean;
  } = {},
): ReadonlyMap<string, SessionHierarchyNode> {
  const byID = new Map(entries.map((entry) => [entry.id, entry]));
  const projects = new Map(entries.map((entry) => [
    entry.id,
    options.project?.(entry.directory, entry.projectID) ?? entry.directory,
  ]));
  const explicit = new Map<string, TaskRecord>();
  for (const task of tasks) {
    for (const id of task.sessions) {
      const project = options.project?.(task.directory) ?? task.directory;
      if (
        !options.followParent && projects.has(id) &&
        projects.get(id) !== project
      ) continue;
      if (!explicit.has(id)) explicit.set(id, task);
    }
  }
  type Family = Pick<SessionHierarchyNode, "familyID" | "rootID" | "ancestry">;
  const families = new Map<string, Family>();
  for (const entry of entries) {
    if (families.has(entry.id)) continue;
    const path: string[] = [], positions = new Map<string, number>();
    let id = entry.id, family: Family;
    while (true) {
      const known = families.get(id);
      if (known) {
        family = known;
        break;
      }
      const cycle = positions.get(id);
      if (cycle !== undefined) {
        family = {
          familyID: path.slice(cycle).sort()[0],
          ancestry: "cyclic",
        };
        break;
      }
      const current = byID.get(id);
      if (!current) {
        family = { familyID: id, ancestry: "unresolved" };
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      if (!current.parentID) {
        family = { familyID: id, rootID: id, ancestry: "complete" };
        break;
      }
      id = current.parentID;
    }
    for (const id of path) families.set(id, family);
  }
  // Local roots and nearest task owners are memoized separately from family
  // identity. A checkout move cannot cut a native family edge.
  const anchors = new Map<string, string>();
  const owners = new Map<string, TaskRecord | undefined>();
  const walk = <T>(
    start: string,
    cache: Map<string, T>,
    value: (id: string) => { value: T } | undefined,
    parent: (id: string) => string | undefined,
    cycleValue: (path: string[]) => T,
  ): void => {
    const path: string[] = [], seen = new Map<string, number>();
    let id = start, result: T;
    while (true) {
      if (cache.has(id)) {
        result = cache.get(id)!;
        break;
      }
      const repeated = seen.get(id);
      if (repeated !== undefined) {
        result = cycleValue(path.slice(repeated));
        break;
      }
      seen.set(id, path.length);
      path.push(id);
      const terminal = value(id);
      if (terminal) {
        result = terminal.value;
        break;
      }
      const next = parent(id);
      if (!next) throw new Error("Hierarchy projection has no terminal");
      id = next;
    }
    for (const id of path) cache.set(id, result);
  };
  const localParent = (id: string) => {
    const parent = byID.get(id)?.parentID;
    return parent && byID.has(parent) &&
        projects.get(parent) === projects.get(id)
      ? parent
      : undefined;
  };
  for (const entry of entries) {
    walk(
      entry.id,
      anchors,
      (id) => localParent(id) ? undefined : { value: id },
      localParent,
      (cycle) => cycle.sort()[0],
    );
    const parent = (id: string) =>
      options.followParent ? byID.get(id)?.parentID : localParent(id);
    walk(
      entry.id,
      owners,
      (id) => {
        const task = explicit.get(id);
        return task || !parent(id) || !byID.has(id)
          ? { value: task }
          : undefined;
      },
      parent,
      () => undefined,
    );
  }
  return new Map(entries.map((entry) => {
    const owner = owners.get(entry.id);
    return [entry.id, {
      ...families.get(entry.id)!,
      anchorID: anchors.get(entry.id)!,
      projectDirectory: projects.get(entry.id)!,
      ...(owner ? { taskID: owner.id, taskDirectory: owner.directory } : {}),
      mandatory: options.mandatory?.(entry.id) ?? false,
      followParent: options.followParent ?? false,
    }];
  }));
}
