// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
export interface TranscriptPreferences {
  timestamps: boolean;
  thinking: "show" | "hide";
  toolDetails: boolean;
  conceal: boolean;
  genericToolOutput: boolean;
  scrollbar: boolean;
  showCost: boolean;
}
export function registerTranscriptPreferences(
  registry: PreferenceRegistry,
): void {
  registry.register({
    key: "showCost",
    default: true,
    validate: booleanPreference,
    label: "Show cost",
    display: { order: 7, control: { kind: "toggle" } },
  });
  registry.register({
    key: "timestamps",
    default: false,
    validate: booleanPreference,
    label: "Always show timestamps",
    display: { order: 1, control: { kind: "toggle" } },
  });
  registry.register({
    key: "toolDetails",
    default: true,
    validate: booleanPreference,
    label: "Tool details",
    display: { order: 2, control: { kind: "toggle" } },
  });
  registry.register({
    key: "conceal",
    default: true,
    validate: booleanPreference,
    label: "Conceal markup",
    display: { order: 3, control: { kind: "toggle" } },
  });
  registry.register({
    key: "genericToolOutput",
    default: false,
    validate: booleanPreference,
    label: "Generic tool output",
    display: { order: 4, control: { kind: "toggle" } },
  });
  registry.register({
    key: "scrollbar",
    default: false,
    validate: booleanPreference,
    label: "Scrollbar",
    display: { order: 6, control: { kind: "toggle" } },
  });
  registry.register({
    key: "thinking",
    default: "hide",
    validate: (value): value is "show" | "hide" =>
      value === "show" || value === "hide",
    label: "Thinking",
    display: {
      order: 8,
      control: {
        kind: "select",
        options: [
          { value: "hide", label: "Hide" },
          { value: "show", label: "Show" },
        ],
      },
    },
  });
}
