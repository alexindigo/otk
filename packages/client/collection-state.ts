// SPDX-License-Identifier: LGPL-3.0-only
/** Absence can only be presented once the owner has an answer for this scope. */
export type CollectionState = "loading" | "empty" | "items";

export function collectionState(
  answered: boolean,
  count: number,
): CollectionState {
  return count > 0 ? "items" : answered ? "empty" : "loading";
}
