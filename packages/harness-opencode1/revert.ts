// SPDX-License-Identifier: LGPL-3.0-only
import type { RevertCapability } from "@otk/harness";
import type { ContentSession } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export function revert(
  client: Client,
  directory: Directory,
  getSession: (id: string) => Promise<ContentSession>,
): RevertCapability {
  return {
    async revert(id, messageID) {
      await client.json(`/session/${encodeURIComponent(id)}/revert`, {
        method: "POST",
        query: { directory: directory.cached(id) },
        body: { messageID },
      });
      return getSession(id);
    },
  };
}
