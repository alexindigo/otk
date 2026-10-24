// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
/** Accessibility preferences owned by the visual-system feature. */
export interface VisualPreferences {
  reducedColors: boolean;
  animationsOff: boolean;
}
export function registerVisualPreferences(registry: PreferenceRegistry): void {
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
