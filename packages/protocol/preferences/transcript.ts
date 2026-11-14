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
  collapseFileChanges: boolean;
  expandWork: boolean;
  expandToolOutput: boolean;
  expandSystem: boolean;
  expandDelegation: boolean;
  expandOutgoing: boolean;
  expandRecords: boolean;
  expandSource: boolean;
  expandCompaction: boolean;
}
export function registerTranscriptPreferences(
  registry: PreferenceRegistry,
): void {
  registry.register({
    key: "collapseFileChanges",
    default: true,
    validate: booleanPreference,
    label: "Expand file changes by default",
    display: {
      order: 5,
      control: { kind: "toggle", onValue: false, offValue: true },
    },
    settings: {
      group: "transcript",
      order: 3,
      control: { kind: "toggle", onValue: false, offValue: true },
    },
  });
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
    label: "Show successful tool rows",
    display: { order: 2, control: { kind: "toggle" } },
    settings: {
      group: "transcript-visibility",
      order: 1,
      control: { kind: "toggle" },
    },
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
    default: true,
    validate: booleanPreference,
    label: "Show results for unrecognized tools",
    display: { order: 4, control: { kind: "toggle" } },
    settings: {
      group: "transcript-visibility",
      order: 2,
      control: { kind: "toggle" },
    },
  });
  registry.register({
    key: "scrollbar",
    default: true,
    validate: booleanPreference,
    label: "Scrollbar",
    display: { order: 6, control: { kind: "toggle" } },
  });
  registry.register({
    key: "thinking",
    default: "hide",
    validate: (value): value is "show" | "hide" =>
      value === "show" || value === "hide",
    label: "Expand thinking by default",
    settings: {
      group: "transcript",
      order: 4,
      control: { kind: "toggle", onValue: "show", offValue: "hide" },
    },
    display: {
      order: 8,
      control: { kind: "toggle", onValue: "show", offValue: "hide" },
    },
  });
  for (
    const [key, label, order] of [
      ["expandWork", "Expand work logs by default", 1],
      ["expandToolOutput", "Expand tool output by default", 2],
      ["expandSystem", "Expand System rows by default", 5],
      ["expandDelegation", "Expand subagent results by default", 6],
      ["expandOutgoing", "Expand outgoing messages by default", 7],
      ["expandRecords", "Expand other native records by default", 8],
      ["expandSource", "Expand native source by default", 9],
      ["expandCompaction", "Always keep session compaction expanded", 10],
    ] as const
  ) {
    registry.register({
      key,
      default: false,
      validate: booleanPreference,
      label,
      settings: { group: "transcript", order, control: { kind: "toggle" } },
    });
  }
}
