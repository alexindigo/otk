// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import { inboxStatus } from "@otk/client";
export type LightState = "blocked" | "working" | "finished" | "none";
export const LIGHT_STATES = {
  blocked: { label: "Needs you", shape: "×" },
  working: { label: "Working", shape: "◐" },
  finished: { label: "Finished, not seen", shape: "✓" },
  none: { label: "No known activity", shape: "○" },
} as const;
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
