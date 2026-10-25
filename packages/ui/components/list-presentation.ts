// SPDX-License-Identifier: LGPL-3.0-only
import type { ContextAction, TaskCrumb } from "@otk/client";

/** Neighbor decisions belong to this snapshot, never a keyed child's old index. */
export function breadcrumbRows(
  crumbs: readonly TaskCrumb[],
  selected?: string,
  editing: (id: string) => boolean = () => false,
) {
  const active = crumbs.findIndex((crumb) => crumb.id === selected);
  const visible = crumbs.map((crumb, index) =>
    editing(crumb.id) || crumbs.length <= 7 || index < 2 ||
    index >= crumbs.length - 2 || Math.abs(index - active) <= 1
  );
  return crumbs.map((crumb, index) => ({
    ...crumb,
    visible: visible[index],
    first: index === 0,
    foldStart: !visible[index] && (index === 0 || visible[index - 1]),
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
