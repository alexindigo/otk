// SPDX-License-Identifier: LGPL-3.0-only
import type { ResourcesCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { DirectoryCatalogs } from "./catalogs.ts";
export interface NativeResource {
  name: string;
  description?: string;
  mimeType?: string;
  uri: string;
  client: string;
}
export function mapResources(resources: Record<string, NativeResource>) {
  return Object.values(resources).map((resource) => ({
    name: resource.name,
    description: resource.description,
    mime: resource.mimeType || "text/plain",
    uri: resource.uri,
    server: resource.client,
  }));
}
export function resources(
  client: Client,
  directory: Directory,
  catalogs?: DirectoryCatalogs,
): ResourcesCapability {
  return {
    async listResources(sessionID, signal) {
      if (catalogs) {
        return await catalogs.get(
          await directory.resolve(sessionID, signal),
          "resources",
          signal,
        );
      }
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
        query: { directory: await directory.resolve(sessionID, signal) },
        signal,
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
