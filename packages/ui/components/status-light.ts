// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import { inboxStatus } from "@otk/client";
export const LIGHT_STATES = {
  blocked: { label: "Needs you", shape: "×" },
  working: { label: "Working", shape: "◐" },
  finished: { label: "Finished, not seen", shape: "✓" },
  dependencies: { label: "Running in terminal", shape: "diamond" },
  none: { label: "No known activity", shape: "○" },
} as const;
export type LightState = keyof typeof LIGHT_STATES;
export function lightDescription(state: LightState, dependencies = 0): string {
  return state === "dependencies"
    ? `${LIGHT_STATES.dependencies.label} (${dependencies})`
    : LIGHT_STATES[state].label;
}
/** Lamps render the server supervision projection; status is never a fallback. */
export function sessionLight(
  entry: IndexEntry,
  inbox: Pick<InboxSnapshot, "seen" | "finishes" | "supervision"> = {
    seen: {},
    finishes: {},
  },
): LightState {
  return inboxStatus(entry, inbox);
}
