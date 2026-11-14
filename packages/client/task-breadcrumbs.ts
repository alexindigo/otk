// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexMetadata,
  SessionHierarchyNode,
  TaskRecord,
} from "@otk/protocol";
import { projectSessionHierarchy } from "@otk/protocol";
import { inboxStatus, type OperationAttention } from "./inbox.ts";
export interface TaskCrumb {
  id: string;
  helper: boolean;
  depth: number;
  external?: boolean;
}
/** Ordered explicit members plus mandatory descendants. The caller may inject
 * its already-resolved hierarchy, including PH1's checkout scope mapping. */
export function taskBreadcrumbs(
  task: Pick<TaskRecord, "id" | "directory" | "sessions">,
  entries: readonly (IndexMetadata & OperationAttention)[],
  tasks: readonly TaskRecord[] = [],
  indexed?: ReadonlyMap<
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
  const actual = tasks.some((candidate) => candidate.id === task.id);
  const projected = !!projection ||
    entries.every((entry) => entry.hierarchy?.followParent === followParent);
  const nodes = projected ? undefined : projectSessionHierarchy(
    entries,
    actual ? tasks : [
      { ...task, name: "", order: 0 },
      ...tasks,
    ],
    { followParent },
  );
  const node = (entry: IndexMetadata) =>
    projection?.get(entry.id) ?? entry.hierarchy;
  const root = entries.find((entry) => task.sessions.includes(entry.id));
  const family = root && node(root)?.familyID;
  const belongs = (entry: IndexMetadata) => {
    if (projected && !actual) {
      return !node(entry)?.taskID && node(entry)?.familyID === family;
    }
    return (projected ? node(entry) : nodes?.get(entry.id))?.taskID ===
      task.id;
  };
  const collected = new Map<string, (IndexMetadata & OperationAttention)[]>();
  const children = indexed ?? collected;
  if (!indexed) {
    for (const entry of entries) {
      if (!entry.parentID) continue;
      const siblings = collected.get(entry.parentID) ?? [];
      siblings.push(entry);
      collected.set(entry.parentID, siblings);
    }
  }
  const visited = new Set(task.sessions), result: TaskCrumb[] = [];
  function helpers(parent: string) {
    const stack = (children.get(parent) ?? []).toReversed().map((entry) => ({
      entry,
      depth: 1,
    }));
    while (stack.length) {
      const { entry: child, depth } = stack.pop()!;
      if (visited.has(child.id) || !belongs(child)) continue;
      visited.add(child.id);
      const status = inboxStatus(child, inbox);
      if (status !== "none") {
        result.push({ id: child.id, helper: true, depth });
      }
      for (const entry of (children.get(child.id) ?? []).toReversed()) {
        stack.push({ entry, depth: depth + 1 });
      }
    }
  }
  for (const id of task.sessions) {
    result.push({ id, helper: false, depth: 0 });
    helpers(id);
  }
  return result;
}
