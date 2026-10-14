// SPDX-License-Identifier: LGPL-3.0-only
import type { ResourcesCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export function resources(
  client: Client,
  directory: Directory,
): ResourcesCapability {
  return {
    async listResources(sessionID) {
      const resources = await client.json<
        Record<
          string,
          {
            name: string;
            description?: string;
            mimeType?: string;
            uri: string;
            client: string;
          }
        >
      >("/experimental/resource", {
        query: { directory: await directory.resolve(sessionID) },
      });
      return Object.values(resources).map((resource) => ({
        name: resource.name,
        description: resource.description,
        mime: resource.mimeType || "text/plain",
        uri: resource.uri,
        server: resource.client,
      }));
    },
  };
}
