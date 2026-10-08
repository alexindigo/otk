// SPDX-License-Identifier: LGPL-3.0-only
export interface Preferences {
  timestamps: boolean;
  thinking: "show" | "hide";
  toolDetails: boolean;
  conceal: boolean;
  genericToolOutput: boolean;
  diffWrap: boolean;
  diffStyle: "auto" | "split" | "unified";
  scrollbar: boolean;
}
export const DEFAULT_PREFS: Readonly<Preferences> = {
  timestamps: false,
  thinking: "hide",
  toolDetails: true,
  conceal: true,
  genericToolOutput: false,
  diffWrap: true,
  diffStyle: "auto",
  scrollbar: false,
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
  if (key === "diffStyle") {
    return typeof value === "string" &&
      ["auto", "split", "unified"].includes(value);
  }
  return typeof value === "boolean";
}
