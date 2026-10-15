// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
export interface DiffPreferences {
  diffWrap: boolean;
  diffStyle: "auto" | "split" | "unified";
}
export function registerDiffPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "diffWrap",
    default: true,
    validate: booleanPreference,
    label: "Wrap diffs",
    display: { order: 5, control: { kind: "toggle" } },
  });
  registry.register({
    key: "diffStyle",
    default: "auto",
    validate: (value): value is "auto" | "split" | "unified" =>
      value === "auto" || value === "split" || value === "unified",
    label: "Diff style",
    display: {
      order: 9,
      control: {
        kind: "select",
        options: [
          { value: "auto", label: "Auto" },
          { value: "split", label: "Split" },
          { value: "unified", label: "Unified" },
        ],
      },
    },
  });
}
