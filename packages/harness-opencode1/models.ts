// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelsCapability } from "@otk/harness";
import type { ModelCatalog } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";

/** Minimal native GET /provider projection, confirmed against stock 1.18.34. */
interface Providers {
  all: {
    id: string;
    name: string;
    models: Record<string, {
      id: string;
      name: string;
      variants?: Record<string, unknown>;
      status: "alpha" | "beta" | "active" | "deprecated";
      cost: { input: number };
      limit?: { context: number };
      release_date?: string;
    }>;
  }[];
  connected: string[];
}

export function models(client: Client, directory: Directory): ModelsCapability {
  return {
    async listModels(sessionID) {
      const query = { directory: await directory.resolve(sessionID) };
      const [native, config] = await Promise.all([
        client.json<Providers>("/provider", { query }),
        client.json<{ model?: string }>("/config", { query }),
      ]);
      const connected = new Set(native.connected);
      const catalog: ModelCatalog = {
        providers: native.all.filter((provider) => connected.has(provider.id))
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            models: Object.values(provider.models).map((model) => ({
              id: model.id,
              name: model.name,
              variants: Object.keys(model.variants ?? {}),
              status: model.status,
              free: provider.id === "opencode" && model.cost.input === 0,
              ...(Number.isFinite(model.limit?.context) &&
                  model.limit!.context > 0
                ? { contextLimit: model.limit!.context }
                : {}),
              ...(model.release_date
                ? { releaseDate: model.release_date }
                : {}),
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
        ) catalog.default = { provider, model };
      }
      return catalog;
    },
  };
}
