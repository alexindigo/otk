// SPDX-License-Identifier: LGPL-3.0-only
import type { PreferenceRegistry } from "../prefs.ts";
export interface ThemePreferences {
  theme: string;
}
/** Theme identity is data, not an enumeration of the installed palettes. */
export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][\w.:-]{0,119}$/.test(value);
}
export function registerThemePreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "theme",
    default: "otk-dark",
    validate: isThemeId,
    label: "Theme",
  });
}
