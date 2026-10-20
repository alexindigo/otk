// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionsCapability } from "@otk/harness";
import {
  belongsToSession,
  type IndexEntry,
  type PermissionRequest,
} from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
/** Instance routing stays native metadata, never part of the neutral request. */
export interface PendingPermission {
  request: PermissionRequest;
  directory?: string;
}
export function permissions(
  client: Client,
  directory: Directory,
  entry: (id: string) => IndexEntry | undefined,
  pending: () => Iterable<PendingPermission>,
): PermissionsCapability {
  return {
    async replyPermission(input) {
      const asking = [...pending()].find(({ request }) =>
        request.id === input.requestID && request.sessionID === input.sessionID
      );
      const target = asking?.directory ??
        await directory.resolve(input.sessionID);
      await client.json(
        `/permission/${encodeURIComponent(input.requestID)}/reply`,
        {
          method: "POST",
          query: { directory: target },
          body: { reply: input.reply, message: input.message },
        },
      );
    },
    listPermissions(sessionID) {
      return Promise.resolve(
        [...pending()].map(({ request }) => request).filter((request) =>
          belongsToSession(request.sessionID, sessionID, entry)
        ).map((request) => structuredClone(request)),
      );
    },
  };
}
