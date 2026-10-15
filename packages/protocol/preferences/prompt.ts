// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
export interface PromptPreferences {
  pasteSummary: boolean;
}
export function registerPromptPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "pasteSummary",
    default: true,
    validate: booleanPreference,
    label: "Paste summaries",
    display: { order: 7, control: { kind: "toggle" } },
  });
}
