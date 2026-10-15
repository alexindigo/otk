// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry } from "@otk/protocol";
export type LightState = "blocked" | "working" | "finished" | "idle";
export const LIGHT_STATES = {
  blocked: { label: "Needs you", shape: "×" },
  working: { label: "Working", shape: "◐" },
  finished: { label: "Finished, not seen", shape: "✓" },
  idle: { label: "Idle", shape: "○" },
} as const;
/** Existing index has no seen marks yet; idle is not an invented unread finish. */
export function sessionLight(entry: IndexEntry): LightState {
  const attention = entry.attention;
  if (
    attention.error || attention.permissions + attention.questions +
          attention.childPermissions + attention.childQuestions > 0
  ) return "blocked";
  return entry.status === "idle" ? "idle" : "working";
}
