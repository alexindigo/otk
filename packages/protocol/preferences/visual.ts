// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
export const TEXT_SIZES = Object.freeze(
  ["90", "100", "110", "125", "150"] as const,
);
export type TextSize = typeof TEXT_SIZES[number];
/** Accessibility preferences owned by the visual-system feature. */
export interface VisualPreferences {
  reducedColors: boolean;
  animationsOff: boolean;
  textSize: TextSize;
}
export function registerVisualPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "textSize",
    default: "100",
    validate: (value): value is TextSize =>
      typeof value === "string" && TEXT_SIZES.some((size) => size === value),
    label: "Text size",
    settings: {
      group: "appearance",
      order: -1,
      control: {
        kind: "segmented",
        options: TEXT_SIZES.map((value) => ({ value, label: `${value}%` })),
      },
    },
  });
  registry.register({
    key: "reducedColors",
    default: false,
    validate: booleanPreference,
    label: "Reduced colours",
    display: { order: 9, control: { kind: "toggle" } },
    settings: { group: "appearance", order: 0, control: { kind: "toggle" } },
  });
  registry.register({
    key: "animationsOff",
    default: false,
    validate: booleanPreference,
    label: "Animations off",
    display: { order: 10, control: { kind: "toggle" } },
    settings: { group: "appearance", order: 1, control: { kind: "toggle" } },
  });
}
