// SPDX-License-Identifier: LGPL-3.0-only
import {
  MAX_FAVOURITE_MODELS,
  MAX_RECENT_MODELS,
  type ModelRef,
} from "@otk/protocol";

function same(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** Call after a successful send, using its captured model; caller persists via prefs. */
export function recordRecentModel(
  recent: readonly ModelRef[],
  sent: ModelRef | undefined,
): ModelRef[] {
  if (!sent) return [...recent];
  return [{ ...sent }, ...recent.filter((item) => !same(item, sent))]
    .slice(0, MAX_RECENT_MODELS);
}

/** New favourites go first; at capacity existing favourites are preserved. */
export function toggleFavouriteModel(
  favourites: readonly ModelRef[],
  model: ModelRef,
): ModelRef[] {
  const rest = favourites.filter((item) => !same(item, model));
  return rest.length !== favourites.length
    ? rest
    : favourites.length >= MAX_FAVOURITE_MODELS
    ? [...favourites]
    : [{ ...model }, ...rest];
}
