// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionRequest } from "@otk/protocol";
import { belongsToSession, type SessionLookup } from "@otk/protocol";
export function oldestPermission(
  requests: PermissionRequest[],
  sessionID: string,
  lookup: SessionLookup,
): PermissionRequest | undefined {
  return requests.filter((request) =>
    belongsToSession(request.sessionID, sessionID, lookup)
  ).sort((a, b) => a.time - b.time)[0];
}
