// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionActionsCapability } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import { mapSession } from "./map.ts";
import type { Session } from "./types.ts";
import type { BootstrapDb } from "./db.ts";
import type { Messages } from "./messages.ts";
import { NATIVE_SCAN_ROWS } from "./messages.ts";
import type { Launch } from "./shell.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";

export function sessionActions(
  client: Client,
  directory: Directory,
  db: BootstrapDb,
  messages: Messages,
  revertCutoff: (id: string) => Promise<string | undefined>,
  launch: Launch,
): SessionActionsCapability {
  return {
    async compact(id, model, operation) {
      const dir = await directory.resolve(id);
      const launched = launch(
        id,
        "compact",
        `/session/${encodeURIComponent(ids.decode(id))}/summarize`,
        {
          method: "POST",
          query: { directory: dir },
          classification: "effect",
          ...(operation ? { operation } : {}),
          body: { providerID: model.provider, modelID: model.model },
        },
      );
      if (operation && launched) await launched.settled;
    },
    async fork(id, through, operation) {
      const dir = await directory.resolve(id);
      let next: string | null | undefined;
      if (through !== undefined) {
        next = db.nextMessageID(id, through);
        if (next === undefined) {
          // Stock pages are oldest first within each newest-to-oldest page.
          let before: string | undefined, found = false;
          do {
            const page = await messages.page(id, NATIVE_SCAN_ROWS, before, dir);
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
        await client.json<Session>(
          `/session/${encodeURIComponent(ids.decode(id))}/fork`,
          {
            method: "POST",
            ...(operation
              ? { classification: "effect" as const, operation }
              : {}),
            query: { directory: dir },
            body: messageID ? { messageID } : {},
          },
        ),
      );
    },
    async remove(id, operation) {
      await client.json(`/session/${encodeURIComponent(ids.decode(id))}`, {
        method: "DELETE",
        ...(operation ? { classification: "effect" as const, operation } : {}),
        query: { directory: await directory.resolve(id) },
      });
    },
    async rename(id, title, operation) {
      return mapSession(
        await client.json<Session>(
          `/session/${encodeURIComponent(ids.decode(id))}`,
          {
            method: "PATCH",
            ...(operation
              ? { classification: "effect" as const, operation }
              : {}),
            query: { directory: await directory.resolve(id) },
            body: { title },
          },
        ),
      );
    },
  };
}
