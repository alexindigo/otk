// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelsCapability } from "@otk/harness";
import type { ModelCatalog } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { DirectoryCatalogs } from "./catalogs.ts";

/** Connected metadata from GET /config/providers on supported stock 1.x natives. */
export interface Providers {
  providers: {
    id: string;
    name: string;
    models: Record<string, {
      id: string;
      name: string;
      variants?: Record<string, unknown>;
      status: "alpha" | "beta" | "active" | "deprecated";
      cost?: {
        input: number;
        output?: number;
        cache?: { read: number; write: number };
      };
      limit?: { context: number };
      release_date?: string;
    }>;
  }[];
}

export function models(
  client: Client,
  directory: Directory,
  catalogs?: DirectoryCatalogs,
): ModelsCapability {
  return {
    async listModels(sessionID, signal) {
      signal?.throwIfAborted();
      const query = { directory: await directory.resolve(sessionID, signal) };
      signal?.throwIfAborted();
      if (catalogs) {
        return await catalogs.get(query.directory, "models", signal);
      }
      const [native, config] = await Promise.all([
        client.json<Providers>("/config/providers", { query, signal }),
        client.json<{ model?: string }>("/config", { query, signal }),
      ]);
      return mapModels(native, config);
    },
  };
}
export function mapModels(
  native: Providers,
  config: { model?: string },
): ModelCatalog {
  const catalog: ModelCatalog = {
    defaultState: "unknown",
    providers: native.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.values(provider.models).map((model) => ({
        id: model.id,
        name: model.name,
        variants: Object.keys(model.variants ?? {}),
        status: model.status,
        free: provider.id === "opencode" && model.cost?.input === 0,
        ...([
            model.cost?.input,
            model.cost?.output,
            model.cost?.cache?.read,
            model.cost?.cache?.write,
          ].every((rate) =>
            typeof rate === "number" && Number.isFinite(rate) && rate >= 0
          )
          ? {
            cost: {
              input: model.cost!.input,
              output: model.cost!.output!,
              cache: {
                read: model.cost!.cache!.read,
                write: model.cost!.cache!.write,
              },
            },
          }
          : {}),
        ...(Number.isFinite(model.limit?.context) &&
            model.limit!.context > 0
          ? { contextLimit: model.limit!.context }
          : {}),
        ...(model.release_date ? { releaseDate: model.release_date } : {}),
      })),
    })),
  };
  const separator = config.model?.indexOf("/") ?? -1;
  if (separator > 0) {
    const provider = config.model!.slice(0, separator);
    const model = config.model!.slice(separator + 1);
    if (
      catalog.providers.some((entry) =>
        entry.id === provider &&
        entry.models.some((entry) => entry.id === model)
      )
    ) {
      catalog.default = { provider, model };
      catalog.defaultState = "configured";
    }
  }
  return catalog;
}
