// SPDX-License-Identifier: LGPL-3.0-only
export interface Preferences {
  "notify.toast": boolean;
  "notify.os": boolean;
  "notify.sound": boolean;
  "notify.badge": boolean;
  theme: "otk-dark" | "otk-light" | "system";
  keymap: Record<string, string>;
  timestamps: boolean;
  thinking: "show" | "hide";
  toolDetails: boolean;
  conceal: boolean;
  genericToolOutput: boolean;
  diffWrap: boolean;
  diffStyle: "auto" | "split" | "unified";
  scrollbar: boolean;
  pasteSummary: boolean;
}
export const DEFAULT_PREFS: Readonly<Preferences> = {
  "notify.toast": true,
  "notify.os": false,
  "notify.sound": false,
  "notify.badge": true,
  theme: "otk-dark",
  keymap: {},
  timestamps: false,
  thinking: "hide",
  toolDetails: true,
  conceal: true,
  genericToolOutput: false,
  diffWrap: true,
  diffStyle: "auto",
  scrollbar: false,
  pasteSummary: true,
};
export type PreferenceKey = keyof Preferences;
export function isPreference(
  key: unknown,
  value: unknown,
): key is PreferenceKey {
  if (typeof key !== "string" || !Object.hasOwn(DEFAULT_PREFS, key)) {
    return false;
  }
  if (key === "thinking") return value === "show" || value === "hide";
  if (key === "theme") {
    return value === "otk-dark" || value === "otk-light" || value === "system";
  }
  if (key === "keymap") {
    return !!value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length <= 100 &&
      Object.entries(value).every(([id, combo]) =>
        /^[\w.:-]{1,120}$/.test(id) && typeof combo === "string" &&
        combo.length <= 100
      );
  }
  if (key === "diffStyle") {
    return typeof value === "string" &&
      ["auto", "split", "unified"].includes(value);
  }
  return typeof value === "boolean";
}
