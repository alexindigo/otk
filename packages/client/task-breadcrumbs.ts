// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexMetadata, TaskRecord } from "@otk/protocol";
import { inboxStatus, type OperationAttention } from "./inbox.ts";
export interface TaskCrumb {
  id: string;
  helper: boolean;
  depth: number;
}
/** Ordered explicit members plus active phantom descendants. Selection and view
 * closure cannot hide mandatory work or retain a finished helper. */
export function taskBreadcrumbs(
  task: Pick<TaskRecord, "id" | "directory" | "sessions">,
  entries: readonly (IndexMetadata & OperationAttention)[],
  tasks: readonly TaskRecord[] = [],
  indexed?: ReadonlyMap<
    string,
    readonly (IndexMetadata & OperationAttention)[]
  >,
): TaskCrumb[] {
  const delegated = new Set(
    tasks.filter((t) => t.directory === task.directory && t.id !== task.id)
      .flatMap((t) => t.sessions),
  );
  const collected = new Map<string, (IndexMetadata & OperationAttention)[]>();
  const children = indexed ?? collected;
  if (!indexed) {
    for (const entry of entries) {
      if (!entry.parentID || entry.directory !== task.directory) continue;
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
      if (visited.has(child.id) || delegated.has(child.id)) continue;
      visited.add(child.id);
      const status = inboxStatus(child, { seen: {}, finishes: {} });
      if (status === "working" || status === "blocked") {
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
