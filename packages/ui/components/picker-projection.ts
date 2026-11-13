// SPDX-License-Identifier: LGPL-3.0-only
/** One immutable search revision, shared by rendering, navigation and picking. */
export function pickerProjection<
  T extends {
    key: string;
    label: string;
    description?: string;
    search?: string;
    unavailable?: string;
  },
>(
  groups: readonly {
    key: string;
    label?: string;
    items: readonly T[];
  }[],
  query: string,
) {
  const needle = query.trim().toLowerCase();
  const rows = new Map<string, {
    kind: "heading" | "option";
    label?: string;
    first?: boolean;
    item?: T;
    position?: number;
    size?: number;
  }>();
  const items = new Map<string, T>();
  const available: string[] = [];
  const indices = new Map<string, number>();
  for (const group of groups) {
    const matches = group.items.filter((item) =>
      `${item.label} ${item.description ?? ""} ${item.search ?? ""}`
        .toLowerCase().includes(needle)
    );
    if (!matches.length) continue;
    if (group.label) {
      rows.set(`heading:${group.key}`, {
        kind: "heading",
        label: group.label,
        first: rows.size === 0,
      });
    }
    for (const [index, item] of matches.entries()) {
      rows.set(`option:${item.key}`, {
        kind: "option",
        label: group.label,
        item,
        position: index + 1,
        size: matches.length,
      });
      items.set(item.key, item);
      if (!item.unavailable) {
        indices.set(item.key, available.length);
        available.push(item.key);
      }
    }
  }
  return { rows, keys: [...rows.keys()], items, available, indices };
}
