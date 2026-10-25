// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionActionsCapability } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import { mapSession } from "./map.ts";
import type { Session } from "./types.ts";
import type { BootstrapDb } from "./db.ts";
import type { Messages } from "./messages.ts";

export function sessionActions(
  client: Client,
  directory: Directory,
  db: BootstrapDb,
  messages: Messages,
  revertCutoff: (id: string) => Promise<string | undefined>,
): SessionActionsCapability {
  return {
    async fork(id, through) {
      const dir = await directory.resolve(id);
      let next: string | null | undefined;
      if (through !== undefined) {
        next = db.nextMessageID(id, through);
        if (next === undefined) {
          // Stock pages are oldest first within each newest-to-oldest page.
          let before: string | undefined, found = false;
          do {
            const page = await messages.page(id, 100, before, dir);
            for (const message of page.items.toReversed()) {
              if (message.info.id === through) {
                found = true;
                break;
              }
              next = message.info.id;
            }
            before = page.next;
          } while (!found && before);
          if (!found) next = undefined;
        }
      }
      const cutoff = await revertCutoff(id);
      const messageID = cutoff && (!next || next >= cutoff) ? cutoff : next;
      return mapSession(
        await client.json<Session>(`/session/${encodeURIComponent(id)}/fork`, {
          method: "POST",
          query: { directory: dir },
          body: messageID ? { messageID } : {},
        }),
      );
    },
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
