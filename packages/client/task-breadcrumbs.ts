// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexMetadata,
  SessionHierarchyNode,
  TaskRecord,
} from "@otk/protocol";
import { entityKey, sessionAncestors } from "@otk/protocol";
import type { InboxStatus, OperationAttention } from "./inbox.ts";
import {
  createEntityStateStore,
  entityState,
  type EntityStateStore,
  lamp,
  sessionEvidence,
  visibleLampStatus,
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
  helpers: TrailCrumb[];
  working: TaskCrumb[];
  status: InboxStatus;
}
/** D67/D66/D3: one owner supplies complete ancestry and the separate helper set.
 * The partition owns membership; entities own activity, delivery and clocks. */
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
  const status = (id: string) =>
    lamp(entities, entityKey("session", id), { now: performance.now() });
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
  const depth = (id: string) =>
    sessionAncestors(id, (key) => entries.get(key)).length;
  const main = ids[0] ?? group?.roots[0];
  const helpers = (group?.members ?? []).filter(
    (id) => {
      const key = entityKey("session", id);
      const value = entityState(entities, key);
      return id !== main && !!entries.get(id)?.parentID &&
        !entries.get(id)?.deleted &&
        !entities.isStale &&
        !!main &&
        sessionAncestors(id, (key) => entries.get(key)).includes(main) &&
        (value === "working" || value === "blocked" &&
            entities.get(key)?.cause !== "failedHelper" ||
          sessionEvidence(entities, key)?.awaitingDelivery === true);
    },
  ).sort((a, b) =>
    depth(a) - depth(b) ||
    entries.get(a)!.timeCreated - entries.get(b)!.timeCreated ||
    (group?.members.indexOf(a) ?? 0) - (group?.members.indexOf(b) ?? 0)
  )
    .map((id): TrailCrumb => ({
      id,
      kind: "helper",
      helper: true,
      depth: depth(id),
      status: status(id),
      run: sessionEvidence(entities, entityKey("session", id))?.run,
    }));
  // Execution lifetimes support Stop admission, independently of D66 eligibility.
  // Native descendants across checkout boundaries share one cycle-safe walk.
  const working: TaskCrumb[] = [];
  if (!entities.isStale && current) {
    const children = new Map<string, string[]>();
    for (const entry of entries.values()) {
      if (!entry.parentID) continue;
      const ids = children.get(entry.parentID) ?? [];
      ids.push(entry.id);
      children.set(entry.parentID, ids);
    }
    const visited = new Set([current]);
    const pending = (children.get(current) ?? []).map((id) => ({
      id,
      depth: 1,
    }));
    while (pending.length) {
      const { id, depth } = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (sessionEvidence(entities, entityKey("session", id))?.work) {
        working.push({ id, kind: "helper", helper: true, depth });
      }
      for (const child of children.get(id) ?? []) {
        pending.push({ id: child, depth: depth + 1 });
      }
    }
    working.sort((a, b) =>
      entries.get(a.id)!.timeCreated - entries.get(b.id)!.timeCreated ||
      a.id.localeCompare(b.id)
    );
  }
  return {
    path,
    helpers,
    working,
    status: visibleLampStatus(helpers.map((helper) => helper.status)),
    crumbs: path,
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
