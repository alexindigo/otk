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

export type AncestorLane = "blank" | "through";
export type JunctionLane = "none" | "tee" | "elbow";
export type NodeLane = "empty" | "art" | "stem";

export interface TreeLaneStates {
  ancestors: readonly AncestorLane[];
  junction: JunctionLane;
  node: NodeLane;
}

/** Path flag k describes the following sibling at depth k+1. Roots never
 * connect to each other, so lane zero is always blank for descendants. */
export function laneStates(
  path: readonly boolean[],
  row: { connected: boolean; art: boolean; stem: boolean },
): TreeLaneStates {
  return {
    ancestors: path.map((_, lane) =>
      lane > 0 && path[lane - 1] ? "through" : "blank"
    ),
    junction: !row.connected || !path.length
      ? "none"
      : path.at(-1)
      ? "tee"
      : "elbow",
    node: row.stem ? "stem" : row.art ? "art" : "empty",
  };
}
