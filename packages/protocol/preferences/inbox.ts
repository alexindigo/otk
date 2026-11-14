// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
export interface InboxPreferences {
  projectAgeing: number[];
  tasksFollowParent: boolean;
}
export const DEFAULT_PROJECT_AGEING: readonly number[] = [2, 8, 24].map((h) =>
  h * 3_600_000
);
export function registerInboxPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "tasksFollowParent",
    label: "Tasks follow their parent across projects",
    default: false,
    validate: booleanPreference,
    settings: { group: "projects", order: 0, control: { kind: "toggle" } },
  });
  registry.register({
    key: "projectAgeing",
    label: "Project ageing thresholds",
    default: [...DEFAULT_PROJECT_AGEING],
    validate: (value): value is number[] =>
      Array.isArray(value) && value.length === 3 &&
      value.every((n, i) =>
        typeof n === "number" && Number.isFinite(n) && n > 0 &&
        (i === 0 || n > value[i - 1])
      ),
  });
}
