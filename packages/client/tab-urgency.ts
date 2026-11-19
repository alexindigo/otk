// SPDX-License-Identifier: LGPL-3.0-only
import { type ProjectStatus, URGENCY_PRIORITY, urgentStatus } from "@otk/protocol";

/** Strip ordering preserves user-attention urgency independently of lamp paint. */
export function sortTabsByUrgency<T extends { id: string }>(
  tabs: T[],
  states: (tab: T) => readonly (ProjectStatus | undefined)[],
  activity: (id: string) => number,
): T[] {
  const urgency = new Map(tabs.map((tab) => [tab.id, urgentStatus(...states(tab))]));
  return tabs.sort((a, b) =>
    URGENCY_PRIORITY.indexOf(urgency.get(a.id)!) -
      URGENCY_PRIORITY.indexOf(urgency.get(b.id)!) ||
    activity(b.id) - activity(a.id) || a.id.localeCompare(b.id)
  );
}
