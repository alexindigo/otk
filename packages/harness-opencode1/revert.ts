// SPDX-License-Identifier: LGPL-3.0-only
import type { RevertCapability } from "@otk/harness";
import type { ContentSession, RestoreCapability } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export const revertPreview = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 200);
export function revert(
  client: Client,
  directory: Directory,
  getSession: (id: string) => Promise<ContentSession>,
): RevertCapability {
  return {
    async revert(id, messageID) {
      await client.json(`/session/${encodeURIComponent(id)}/revert`, {
        method: "POST",
        query: { directory: await directory.resolve(id) },
        body: { messageID },
      });
      return getSession(id);
    },
  };
}
export function restore(
  client: Client,
  directory: Directory,
  getSession: (id: string) => Promise<ContentSession>,
): RestoreCapability {
  return {
    async restore(id) {
      await client.json(`/session/${encodeURIComponent(id)}/unrevert`, {
        method: "POST",
        query: { directory: await directory.resolve(id) },
      });
      return getSession(id);
    },
  };
}
