// SPDX-License-Identifier: LGPL-3.0-only
/** Continuation flags for a preorder hierarchy, independent of mounted neighbours. */
export function treePaths<T>(
  rows: readonly T[],
  depth: (row: T) => number,
): boolean[][] {
  const result: boolean[][] = new Array(rows.length);
  const following: number[] = [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const value = depth(rows[index]);
    result[index] = Array.from(
      { length: value },
      (_, level) => following[level + 1] === level + 1,
    );
    for (let level = value; level < following.length; level++) {
      following[level] = value;
    }
    following[value] = value;
  }
  return result;
}
