// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionsCapability } from "@otk/harness";
import {
  belongsToSession,
  type PermissionRequest,
  type SessionLookup,
} from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
/** Instance routing stays native metadata, never part of the neutral request. */
export interface PendingPermission {
  request: PermissionRequest;
  directory?: string;
  generation?: number;
}
export function permissions(
  client: Client,
  directory: Directory,
  entry: SessionLookup,
  pending: () => Iterable<PendingPermission>,
): PermissionsCapability {
  return {
    async replyPermission(input, operation) {
      ids.decode(input.sessionID);
      const asking = [...pending()].find(({ request }) =>
        request.id === input.requestID && request.sessionID === input.sessionID
      );
      const target = asking?.directory ??
        await directory.resolve(input.sessionID);
      await client.json(
        `/permission/${encodeURIComponent(input.requestID)}/reply`,
        {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory: target },
          body: { reply: input.reply, message: input.message },
        },
      );
    },
    listPermissions(sessionID, signal) {
      ids.decode(sessionID);
      return new Promise((resolve) => {
        signal?.throwIfAborted();
        resolve(
          [...pending()].map(({ request }) => request).filter((request) =>
            belongsToSession(request.sessionID, sessionID, entry)
          ).map((request) => structuredClone(request)),
        );
      });
    },
  };
}
