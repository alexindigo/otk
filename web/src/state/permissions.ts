// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionRequest } from "../../../protocol/content.ts";
import {
  belongsToSession,
  type SessionLookup,
} from "../../../protocol/session-tree.ts";
export function oldestPermission(
  requests: PermissionRequest[],
  sessionID: string,
  lookup: SessionLookup,
): PermissionRequest | undefined {
  return requests.filter((request) =>
    belongsToSession(request.sessionID, sessionID, lookup)
  ).sort((a, b) => a.time - b.time)[0];
}
