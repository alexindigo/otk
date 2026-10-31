// SPDX-License-Identifier: LGPL-3.0-only
import type { ContextAction, TaskCrumb } from "@otk/client";

/** Neighbor decisions belong to this snapshot, never a keyed child's old index. */
export function breadcrumbRows(
  crumbs: readonly TaskCrumb[],
) {
  return crumbs.map((crumb, index) => ({
    ...crumb,
    key: crumb.id,
    first: index === 0,
  }));
}

/** Preserve the hub's exact action identity while projecting separators. */
export function commandRows(actions: readonly ContextAction[]) {
  return actions.map((action, index) => ({
    action,
    separator: action.destructive &&
      (index === 0 || !actions[index - 1].destructive),
  }));
}
