// SPDX-License-Identifier: LGPL-3.0-only
import {
  autoApproveOwner,
  type IndexEntry,
  type PermissionRequest,
  sessionAncestors,
  type SessionLookup,
} from "@otk/protocol";

/** One definition of waiting for the user, shared by requests and index consumers.
 * Native pending metadata is retained unchanged for reconnect and policy changes. */
export interface ApprovalAttention {
  waiting(sessionID: string): boolean;
  permissions(requests: readonly PermissionRequest[]): PermissionRequest[];
  entries<T extends IndexEntry>(entries: readonly T[]): T[];
}
export function approvalAttention(
  enabled: readonly string[],
  lookup: SessionLookup,
  linked: boolean,
): ApprovalAttention {
  const waiting = (id: string) =>
    !linked || !autoApproveOwner(id, enabled, lookup);
  return {
    waiting,
    permissions: (requests: readonly PermissionRequest[]) =>
      requests.filter((r) => waiting(r.sessionID)),
    entries<T extends IndexEntry>(entries: readonly T[]): T[] {
      if (!linked || !enabled.length) return [...entries];
      // Subtract each covered subtree once, even when an uncovered ancestor has
      // both manual and automatic helper branches. Native roll-ups may include
      // descendants outside the visible index window.
      const boundaries = entries.filter((e) =>
        !waiting(e.id) && (!e.parentID || waiting(e.parentID))
      );
      return entries.map((entry) => {
        const covered = !waiting(entry.id);
        const childCovered = covered
          ? entry.attention.childPermissions
          : boundaries.reduce((sum, subtree) =>
            sessionAncestors(subtree.id, lookup).includes(entry.id)
              ? sum + subtree.attention.permissions +
                subtree.attention.childPermissions
              : sum, 0);
        return {
          ...entry,
          attention: {
            ...entry.attention,
            permissions: covered ? 0 : entry.attention.permissions,
            childPermissions: Math.max(
              0,
              entry.attention.childPermissions - childCovered,
            ),
          },
        };
      });
    },
  };
}
