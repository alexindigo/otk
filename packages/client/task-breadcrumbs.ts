// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type IndexEntry,
  type TaskRecord,
} from "@otk/protocol";
export interface TaskCrumb {
  id: string;
  helper: boolean;
  depth: number;
}
/** Ordered membership is authoritative. Expand the selected helper path without
 * duplicating explicitly grouped children or following cyclic backend ancestry. */
export function taskBreadcrumbs(
  task: TaskRecord,
  entries: readonly IndexEntry[],
  selected?: string,
  closed: readonly string[] = [],
): TaskCrumb[] {
  const lookup = (id: string) =>
    entries.find((e) => e.id === id && e.directory === task.directory);
  const owner = task.sessions.find((id) =>
    belongsToSession(selected ?? "", id, lookup)
  );
  const visited = new Set(task.sessions), result: TaskCrumb[] = [];
  function helpers(parent: string, depth: number) {
    for (
      const child of entries.filter((e) =>
        e.parentID === parent && e.directory === task.directory
      )
    ) {
      if (visited.has(child.id)) continue;
      if (
        closed.includes(child.id) &&
        !belongsToSession(selected ?? "", child.id, lookup)
      ) continue;
      visited.add(child.id);
      result.push({ id: child.id, helper: true, depth });
      if (belongsToSession(selected ?? "", child.id, lookup)) {
        helpers(child.id, depth + 1);
      }
    }
  }
  for (const id of task.sessions) {
    result.push({ id, helper: false, depth: 0 });
    if (id === owner) helpers(id, 1);
  }
  return result;
}
