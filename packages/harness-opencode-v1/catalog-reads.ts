// SPDX-License-Identifier: LGPL-3.0-only
import type { ProviderReaders } from "@otk/harness";
import type { SkillOption } from "@otk/protocol";
import type { Client } from "./client.ts";
import { type Agent, mapAgents } from "./agents.ts";
import { mapCommands } from "./commands.ts";
import { mapModels, type Providers } from "./models.ts";
import { mapResources, type NativeResource } from "./resources.ts";
import { mapQuestion } from "./questions.ts";
import type { RawPermission, RawQuestion } from "./types.ts";
import { mapPermission } from "./map.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import type { SessionMetadata } from "@otk/protocol";
import { readCatalogFiles } from "./catalog-files.ts";
import { NativeReadiness } from "./readiness.ts";

/** Native endpoint knowledge stays with the contributing feature. No retained worker catalog. */
export function catalogReaders(
  client: Client,
  metadataAdmission = client.admission,
): ProviderReaders {
  const metadata = new NativeReadiness(client.wait, metadataAdmission);
  return {
    "activity.status": async ({ directory }, signal) => {
      const statuses = await client.json<
        Record<
          string,
          {
            type: SessionMetadata["status"];
            attempt?: number;
            message?: string;
            next?: number;
          }
        >
      >("/session/status", { query: { directory }, signal });
      return Object.entries(statuses).map(([id, status]) => ({
        id: ids.encode(id),
        status: status.type,
        ...(status.type === "retry"
          ? {
            retry: {
              attempt: status.attempt!,
              message: status.message!,
              next: status.next!,
            },
          }
          : {}),
      }));
    },
    "activity.permissions": async ({ directory }, signal) =>
      (await client.json<RawPermission[]>("/permission", {
        query: { directory },
        signal,
      })).map((request) => mapPermission(request, Date.now())),
    "catalog.agents": async ({ directory }, signal) => {
      const raw = await client.json<Agent[]>("/agent", {
        query: { directory },
        signal,
      });
      const value = mapAgents(raw);
      return value;
    },
    "catalog.commands": async ({ directory }, signal) =>
      mapCommands(
        await client.json("/command", { query: { directory }, signal }),
      ),
    "catalog.skills": async ({ directory }, signal) =>
      (await client.json<SkillOption[]>("/skill", {
        query: { directory },
        signal,
      })).map(({ name, description }) => ({ name, description })),
    "catalog.models": async ({ directory }, signal) => {
      // Sequential native reads share the worker's I/O permission and scheduler turns.
      const native = await client.json<Providers>("/config/providers", {
        query: { directory },
        signal,
      });
      const config = await client.json<{ model?: string }>("/config", {
        query: { directory },
        signal,
      });
      return mapModels(native, config);
    },
    "catalog.resources": async ({ directory }, signal) =>
      mapResources(
        await client.json<Record<string, NativeResource>>(
          "/experimental/resource",
          { query: { directory }, signal },
        ),
      ),
    "catalog.questions": async ({ directory }, signal) =>
      (await client.json<RawQuestion[]>("/question", {
        query: { directory },
        signal,
      })).map(mapQuestion),
    "catalog.files": ({ directory, path }, signal) =>
      readCatalogFiles(client, directory, path, signal, metadata),
  };
}
