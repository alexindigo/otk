// SPDX-License-Identifier: LGPL-3.0-only
export interface WindowAnchor {
  key: string;
  offset: number;
}
export interface WindowRange {
  start: number;
  end: number;
  before: number;
  after: number;
  visibleKeys: string[];
}
/** Prefix sums with O(log n) measurement and offset lookup. No browser state. */
export function createWindow(): {
  update(keys: readonly string[], estimate: (key: string) => number): void;
  measure(key: string, size: number): boolean;
  offset(key: string): number | undefined;
  size(key: string): number;
  total(): number;
  anchor(top: number): WindowAnchor | undefined;
  restore(anchor?: WindowAnchor): number | undefined;
  range(
    top: number,
    height: number,
    overscan?: number,
    pinned?: readonly string[],
  ): WindowRange;
} {
  let keys: readonly string[] = [],
    positions = new Map<string, number>(),
    sums: number[] = [0],
    sizes: number[] = [];
  const measured = new Map<string, number>();
  const add = (i: number, delta: number) => {
    for (i++; i < sums.length; i += i & -i) sums[i] += delta;
  };
  const prefix = (i: number) => {
    let value = 0;
    for (; i > 0; i -= i & -i) value += sums[i];
    return value;
  };
  const at = (offset: number) => {
    let low = 0, high = keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (prefix(mid + 1) <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const offset = (key: string) => {
    const i = positions.get(key);
    return i === undefined ? undefined : prefix(i);
  };
  return {
    update(next, estimate) {
      keys = [...next];
      positions = new Map(keys.map((key, i) => [key, i]));
      for (const key of measured.keys()) {
        if (!positions.has(key)) measured.delete(key);
      }
      sizes = keys.map((key) =>
        measured.get(key) ?? Math.max(1, estimate(key))
      );
      sums = Array(keys.length + 1).fill(0);
      // Linear Fenwick construction.
      for (let i = 1; i < sums.length; i++) {
        sums[i] += sizes[i - 1];
        const parent = i + (i & -i);
        if (parent < sums.length) sums[parent] += sums[i];
      }
    },
    measure(key, size) {
      const i = positions.get(key);
      if (
        i === undefined || !Number.isFinite(size) || size <= 0 ||
        sizes[i] === size
      ) return false;
      measured.set(key, size);
      add(i, size - sizes[i]);
      sizes[i] = size;
      return true;
    },
    offset,
    size: (key) => sizes[positions.get(key) ?? -1] ?? 0,
    total: () => prefix(keys.length),
    anchor(top) {
      const i = Math.min(at(Math.max(0, top)), keys.length - 1);
      return i < 0 ? undefined : { key: keys[i], offset: top - prefix(i) };
    },
    restore(anchor) {
      const top = anchor && offset(anchor.key);
      return top === undefined ? undefined : top + anchor!.offset;
    },
    range(top, height, overscan = 0, pinned = []) {
      if (!keys.length || height <= 0) {
        return {
          start: 0,
          end: 0,
          before: 0,
          after: prefix(keys.length),
          visibleKeys: [],
        };
      }
      const start = Math.max(0, at(Math.max(0, top)) - overscan);
      const edge = Math.max(0, top) + height;
      const last = at(Math.max(0, edge - .001));
      const end = Math.min(keys.length, last + 1 + overscan);
      const indices = new Set(
        Array.from({ length: end - start }, (_, i) => start + i),
      );
      for (const key of pinned) {
        const i = positions.get(key);
        if (i !== undefined) indices.add(i);
      }
      return {
        start,
        end,
        before: prefix(start),
        after: prefix(keys.length) - prefix(end),
        visibleKeys: [...indices].sort((a, b) => a - b).map((i) => keys[i]),
      };
    },
  };
}
