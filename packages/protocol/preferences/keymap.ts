// SPDX-License-Identifier: LGPL-3.0-only
import type { PreferenceRegistry } from "../prefs.ts";
export interface KeymapPreferences {
  keymap: Record<string, string>;
}
export function registerKeymapPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "keymap",
    default: {},
    label: "Keyboard shortcuts",
    validate: (value): value is Record<string, string> =>
      !!value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length <= 100 &&
      Object.entries(value).every(([id, combo]) =>
        /^[\w.:-]{1,120}$/.test(id) && typeof combo === "string" &&
        combo.length <= 100
      ),
  });
}
