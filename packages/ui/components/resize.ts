// SPDX-License-Identifier: LGPL-3.0-only
/** One immutable gesture origin: borders and the grab point cannot change size.
 * Owners persist the invocation's final coordinate, not a previous painted read. */
export function resizeDrag(
  width: number,
  pointer: number,
  direction: 1 | -1,
  min: number,
  max: number,
): (current: number) => number {
  return (current) =>
    Math.max(min, Math.min(max, width + (current - pointer) * direction));
}
