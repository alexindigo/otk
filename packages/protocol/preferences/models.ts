// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "../content.ts";
import type { PreferenceRegistry } from "../prefs.ts";

export const MAX_RECENT_MODELS = 10;
export const MAX_FAVOURITE_MODELS = 50;

export interface ModelPreferences {
  "models.recent": ModelRef[];
  "models.favourite": ModelRef[];
}

function modelList(value: unknown, max: number): value is ModelRef[] {
  if (!Array.isArray(value) || value.length > max) return false;
  const keys = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const ref = item as Record<string, unknown>;
    if (
      Object.keys(ref).length !== 2 ||
      !Object.hasOwn(ref, "provider") || !Object.hasOwn(ref, "model") ||
      typeof ref.provider !== "string" || !ref.provider.length ||
      typeof ref.model !== "string" || !ref.model.length
    ) return false;
    const key = JSON.stringify([ref.provider, ref.model]);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export function registerModelPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "models.recent",
    label: "Recent models",
    default: [],
    validate: (value): value is ModelRef[] =>
      modelList(value, MAX_RECENT_MODELS),
  });
  registry.register({
    key: "models.favourite",
    label: "Favourite models",
    default: [],
    validate: (value): value is ModelRef[] =>
      modelList(value, MAX_FAVOURITE_MODELS),
  });
}
