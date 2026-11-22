// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexMetadata,
  SessionHierarchyNode,
  TaskRecord,
} from "@otk/protocol";
import { sessionAncestors } from "@otk/protocol";
import { inboxStatus, type OperationAttention } from "./inbox.ts";
import {
  projectTabGroups,
  resolveTabHierarchy,
  type TabGroup,
} from "./tab-groups.ts";
export interface TaskCrumb {
  id: string;
  kind: "member" | "ancestor" | "family";
  helper: boolean;
  depth: number;
  /** Compatibility flag for navigable orientation links, including local parents. */
  external?: boolean;
}

/** Visibility borrows the complete partition; it cannot admit another group's
 * members. Quiet inherited members retire unless they are the viewed session. */
export function groupBreadcrumbs(
  group: TabGroup,
  entries: ReadonlyMap<string, IndexMetadata & OperationAttention>,
  mandatory: ReadonlySet<string>,
  selected?: string,
): TaskCrumb[] {
  const roots = new Set(group.roots), members = new Set(group.members);
  const result: TaskCrumb[] = [];
  for (const id of group.members) {
    if (!roots.has(id) && !mandatory.has(id) && id !== selected) continue;
    const ancestors = sessionAncestors(id, (key) => entries.get(key));
    const at = ancestors.findIndex((ancestor) => roots.has(ancestor));
    result.push({
      id,
      kind: "member",
      helper: !roots.has(id),
      depth: roots.has(id) ? 0 : at < 0 ? 1 : at + 1,
    });
  }
  for (const id of group.ancestorLinks) {
    if (members.has(id)) continue;
    const at = result.findIndex((crumb) =>
      sessionAncestors(crumb.id, (key) => entries.get(key)).includes(id)
    );
    if (at < 0) continue;
    result.splice(at, 0, {
      id,
      kind: "ancestor",
      helper: false,
      depth: 0,
      external: true,
    });
  }
  for (const id of group.familyLinks) {
    if (!mandatory.has(id) && id !== selected) continue;
    if (result.some((crumb) => crumb.id === id)) continue;
    result.push({ id, kind: "family", helper: true, depth: 1, external: true });
  }
  return result;
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
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "supervision"> = {
    seen: {},
    finishes: {},
  },
  followParent = false,
  projection?: ReadonlyMap<string, SessionHierarchyNode>,
): TaskCrumb[] {
  const saved = tasks.some((candidate) => candidate.id === task.id)
    ? tasks
    : [{ ...task, name: "", order: 0 }, ...tasks];
  const hierarchy = resolveTabHierarchy(entries, saved, {
    followParent,
    hierarchy: projection,
  });
  const mandatory = new Set(
    entries.filter((entry) =>
      inboxStatus(entry, inbox) !== "none" ||
      hierarchy?.get(entry.id)?.mandatory
    ).map((
      entry,
    ) => entry.id),
  );
  const groups = projectTabGroups(entries, saved, {
    followParent,
    hierarchy,
    mandatory,
  });
  const group = groups.groups.find((group) =>
    group.kind === "task" && group.id === task.id
  );
  if (!group) return [];
  return groupBreadcrumbs(
    group,
    new Map(entries.map((entry) => [entry.id, entry])),
    mandatory,
  );
}
