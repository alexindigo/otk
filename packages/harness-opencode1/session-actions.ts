// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionActionsCapability } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import { mapSession } from "./map.ts";
import type { Session } from "./types.ts";

export function sessionActions(
  client: Client,
  directory: Directory,
): SessionActionsCapability {
  return {
    async remove(id) {
      await client.json(`/session/${encodeURIComponent(id)}`, {
        method: "DELETE",
        query: { directory: await directory.resolve(id) },
      });
    },
    async rename(id, title) {
      return mapSession(
        await client.json<Session>(
          `/session/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            query: { directory: await directory.resolve(id) },
            body: { title },
          },
        ),
      );
    },
  };
}
