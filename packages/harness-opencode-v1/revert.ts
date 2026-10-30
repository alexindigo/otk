// SPDX-License-Identifier: LGPL-3.0-only
import type { RevertCapability } from "@otk/harness";
import type { ContentSession, RestoreCapability } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
export const revertPreview = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 200);
export function revert(
  client: Client,
  directory: Directory,
  getSession: (id: string) => Promise<ContentSession>,
): RevertCapability {
  return {
    async revert(id, messageID, operation) {
      await client.json(
        `/session/${encodeURIComponent(ids.decode(id))}/revert`,
        {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory: await directory.resolve(id) },
          body: { messageID },
        },
      );
      await operation?.checkpoint("session-boundary", {
        kind: "session-boundary",
        value: { sessionID: id, messageID },
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
    async restore(id, operation) {
      await client.json(
        `/session/${encodeURIComponent(ids.decode(id))}/unrevert`,
        {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory: await directory.resolve(id) },
        },
      );
      await operation?.checkpoint("session-boundary", {
        kind: "session-boundary",
        value: { sessionID: id, messageID: null },
      });
      return getSession(id);
    },
  };
}
