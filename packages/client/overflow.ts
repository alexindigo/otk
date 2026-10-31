// SPDX-License-Identifier: LGPL-3.0-only
/** Root then closest selected ancestors, with cycle-safe original-order fallback. */
export function overflowPreference(
  keys: readonly string[],
  selected: string | undefined,
  parent: (key: string) => string | undefined,
): string[] {
  const order = new Set<string>();
  if (keys[0]) order.add(keys[0]);
  const visited = new Set<string>();
  for (let key = selected; key && !visited.has(key); key = parent(key)) {
    visited.add(key);
    if (key !== selected && keys.includes(key)) order.add(key);
  }
  return [...order, ...keys.filter((key) => !order.has(key))];
}
/** One measured snapshot; required values may shrink, never disappear. */
export function fitOverflow(input: {
  keys: readonly string[];
  widths: ReadonlyMap<string, number>;
  available: number;
  required: readonly string[];
  preferred?: readonly string[];
  moreWidth: number;
  gap: number;
}): { visible: string[]; overflow: string[] } {
  const { keys, widths, available, gap } = input;
  const width = (key: string) => widths.get(key) ?? 0;
  if (
    keys.reduce((sum, key) => sum + width(key), 0) +
        Math.max(0, keys.length - 1) * gap <= available
  ) return { visible: [...keys], overflow: [] };
  const visible = new Set(input.required.filter((key) => keys.includes(key)));
  let used = [...visible].reduce((sum, key) => sum + width(key), 0) +
    visible.size * gap + input.moreWidth;
  for (const key of [...(input.preferred ?? []), ...keys]) {
    if (visible.has(key) || !keys.includes(key)) continue;
    if (used + width(key) + gap <= available) {
      visible.add(key);
      used += width(key) + gap;
    }
  }
  return {
    visible: keys.filter((key) => visible.has(key)),
    overflow: keys.filter((key) => !visible.has(key)),
  };
}
