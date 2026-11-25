// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexMetadata,
  SessionHierarchyNode,
  TaskRecord,
} from "@otk/protocol";
import { entityKey, sessionAncestors, taskEntityID } from "@otk/protocol";
import type { InboxStatus, OperationAttention } from "./inbox.ts";
import {
  createEntityStateStore,
  type EntityStateStore,
  lamp,
} from "./entity-state.ts";
import {
  projectTabGroups,
  resolveTabHierarchy,
  type TabGroup,
} from "./tab-groups.ts";
export interface TaskCrumb {
  id: string;
  kind: "member" | "ancestor" | "helper";
  helper: boolean;
  depth: number;
  /** Compatibility flag for navigable orientation links, including local parents. */
  external?: boolean;
}
export interface TrailCrumb extends TaskCrumb {
  status: InboxStatus;
  run?: { startedAt: number; endedAt?: number };
}
export interface TrailModel {
  crumbs: TrailCrumb[];
  path: TrailCrumb[];
  task?: string;
}
/** D67: crumbs describe ancestry, not task membership. */
export function buildTrail(
  group: TabGroup | undefined,
  entries: ReadonlyMap<string, IndexMetadata & OperationAttention>,
  entities: EntityStateStore,
  selected?: string,
): TrailModel {
  const current = selected ?? group?.roots[0];
  const ids = current
    ? [
      ...sessionAncestors(current, (id) => entries.get(id)).toReversed(),
      current,
    ].filter((id, at, all) => entries.has(id) && all.indexOf(id) === at)
    : [];
  const members = new Set(group?.members);
  const status = (id: string) => lamp(entities, entityKey("session", id));
  const directory = current ? entries.get(current)?.directory : undefined;
  const path = ids.map((id, depth): TrailCrumb => {
    const entry = entries.get(id)!;
    const external = !members.has(id) || entry.directory !== directory;
    return {
      id,
      kind: external ? "ancestor" : "member",
      helper: !!entry.parentID,
      depth,
      status: status(id),
      ...(external ? { external: true } : {}),
    };
  });
  return {
    path,
    crumbs: path,
    task: group && entityKey("task", taskEntityID(group.kind, group.id)),
  };
}

/** Standalone explicit-member projection uses the same group owner as tabs.
 * A task-like record not yet persisted still declares explicit membership; no
 * synthetic phantom/global-family exception exists. */
export function taskBreadcrumbs(
  task: Pick<TaskRecord, "id" | "directory" | "sessions">,
  entries: readonly (IndexMetadata & OperationAttention)[],
  tasks: readonly TaskRecord[] = [],
  _indexed?: ReadonlyMap<
    string,
    readonly (IndexMetadata & OperationAttention)[]
  >,
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "entities"> = {
    seen: {},
    finishes: {},
  },
  followParent = false,
  projection?: ReadonlyMap<string, SessionHierarchyNode>,
): TrailCrumb[] {
  const saved = tasks.some((candidate) => candidate.id === task.id)
    ? tasks
    : [{ ...task, name: "", order: 0 }, ...tasks];
  const hierarchy = resolveTabHierarchy(entries, saved, {
    followParent,
    hierarchy: projection,
  });
  const groups = projectTabGroups(entries, saved, {
    followParent,
    hierarchy,
    retained: new Set(task.sessions),
  });
  const group = groups.groups.find((group) =>
    group.kind === "task" && group.id === task.id
  );
  if (!group) return [];
  const entities = createEntityStateStore({ read: () => inbox.entities });
  const trail = buildTrail(
    group,
    new Map(entries.map((entry) => [entry.id, entry])),
    entities,
  );
  entities.stop();
  return trail.crumbs;
}
