// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ProjectStatus,
  URGENCY_PRIORITY,
  urgentStatus,
} from "@otk/protocol";
import { ATTENTION_GRACE_MS } from "./attention-grace.ts";
import {
  createSettledOrder,
  type SettledOrderOptions,
} from "./settled-order.ts";

/** Strip ordering preserves user-attention urgency independently of lamp paint. */
export function createTabOrder<T extends { id: string }>(
  changed: () => void,
  options: SettledOrderOptions = {},
) {
  const owner = createSettledOrder<T>(changed, options);
  return {
    ...owner,
    tabs(
      tabs: readonly T[],
      states: (tab: T) => readonly (ProjectStatus | undefined)[],
      activity: (id: string) => number,
      permissionOnly: (tab: T) => boolean,
    ): T[] {
      return owner.order(tabs, (tab) => {
        const state = urgentStatus(...states(tab));
        return {
          priority: URGENCY_PRIORITY.indexOf(state),
          activity: activity(tab.id),
          ...(state === "blocked"
            ? { urgentMs: permissionOnly(tab) ? ATTENTION_GRACE_MS : 0 }
            : {}),
        };
      });
    },
  };
}
