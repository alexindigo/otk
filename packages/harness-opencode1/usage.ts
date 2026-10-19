// SPDX-License-Identifier: LGPL-3.0-only
import { type UsageCapability, usageHeader, UsageLedger } from "@otk/protocol";
import type { BootstrapDb } from "./db.ts";
import type { Messages } from "./messages.ts";
import type { Directory } from "./directory.ts";
import { mapMessage } from "./map.ts";
export function usage(
  db: BootstrapDb,
  messages: Messages,
  directory: Directory,
): UsageCapability {
  return {
    async getUsage(id) {
      const ledger = new UsageLedger(id), rows = db.usageMessages(id);
      if (rows) { for (const row of rows) ledger.upsert(row); }
      else {for await (
          const row of messages.scan(id, await directory.resolve(id))
        ) {
          if (row.info.role !== "assistant") continue;
          const message = mapMessage(row.info);
          if (message.role === "assistant") ledger.upsert(usageHeader(message));
        }}
      return ledger.snapshot();
    },
  };
}
