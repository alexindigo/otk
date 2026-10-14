// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionsCapability } from "@otk/harness";
import { belongsToSession, type IndexEntry } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { RawPermission } from "./types.ts";
import { mapPermission } from "./map.ts";
export function permissions(
  client: Client,
  directory: Directory,
  entry: (id: string) => IndexEntry | undefined,
  time: (id: string) => number | undefined,
): PermissionsCapability {
  return {
    async replyPermission(input) {
      await client.json(
        `/permission/${encodeURIComponent(input.requestID)}/reply`,
        {
          method: "POST",
          query: { directory: directory.cached(input.sessionID) },
          body: { reply: input.reply, message: input.message },
        },
      );
    },
    async listPermissions(sessionID) {
      const pending = await client.json<RawPermission[]>("/permission", {
        query: { directory: await directory.resolve(sessionID) },
      });
      return pending.filter((request) =>
        belongsToSession(request.sessionID, sessionID, entry)
      ).map((request) => mapPermission(request, time(request.id)));
    },
  };
}
