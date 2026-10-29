// SPDX-License-Identifier: LGPL-3.0-only
import {
  type TurnUsageSnapshot,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import type { BootstrapDb } from "./db.ts";
import type { Messages } from "./messages.ts";
import type { Directory } from "./directory.ts";
import { mapMessage } from "./map.ts";
export function usage(
  db: BootstrapDb,
  messages: Messages,
  directory: Directory,
): {
  getUsage(
    id: string,
    turnID: string,
    signal?: AbortSignal,
  ): Promise<TurnUsageSnapshot>;
} {
  return {
    async getUsage(id, turnID, signal) {
      const ledger = new UsageLedger(id),
        rows = db.usageMessages(id, turnID, signal);
      if (rows) { for (const row of rows) ledger.upsert(row); }
      else {for await (
          const row of messages.scan(id, await directory.resolve(id), signal)
        ) {
          if (
            row.info.role !== "assistant" ||
            (row.info.parentID ?? row.info.id) !== turnID
          ) continue;
          const message = mapMessage(row.info);
          if (message.role === "assistant") {
            ledger.upsert({
              ...usageHeader(message),
              tools: row.parts.filter((part) => part.type === "tool").map((
                part,
              ) => ({
                id: part.id,
                name: part.tool!,
                ...(part.state?.title == null
                  ? {}
                  : { summary: part.state.title }),
              })),
            });
          }
        }}
      return ledger.detail(turnID);
    },
  };
}
