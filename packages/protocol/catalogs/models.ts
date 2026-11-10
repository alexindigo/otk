// SPDX-License-Identifier: LGPL-3.0-only
import type { CatalogCodec } from "../catalogs.ts";
import type { ModelCatalog } from "../models.ts";
export interface ModelCatalogKinds {
  models: ModelCatalog;
}
export interface ModelChunkKinds {
  models: CatalogModelItem;
}
export type CatalogModelItem =
  | {
    kind: "catalog";
    defaultState: ModelCatalog["defaultState"];
    default?: ModelCatalog["default"];
    defaultVariant?: string;
    provenance?: ModelCatalog["provenance"];
  }
  | {
    kind: "provider";
    id: string;
    name: string;
    provenance?: ModelCatalog["provenance"];
    availability?: ModelCatalog["providers"][number]["availability"];
  }
  | {
    kind: "model";
    providerID: string;
    model: ModelCatalog["providers"][number]["models"][number];
  };
export const modelCatalogCodec: CatalogCodec<"models"> = {
  *chunks(value, rows) {
    function* entries(): Generator<CatalogModelItem> {
      yield {
        kind: "catalog",
        defaultState: value.defaultState,
        default: value.default,
        defaultVariant: value.defaultVariant,
        provenance: value.provenance,
      };
      for (const provider of value.providers) {
        yield {
          kind: "provider",
          id: provider.id,
          name: provider.name,
          provenance: provider.provenance,
          availability: provider.availability,
        };
        for (const model of provider.models) {
          yield { kind: "model", providerID: provider.id, model };
        }
      }
    }
    let chunk: CatalogModelItem[] = [];
    for (const item of entries()) {
      chunk.push(item);
      if (chunk.length === rows) {
        yield chunk;
        chunk = [];
      }
    }
    if (chunk.length) yield chunk;
  },
  create() {
    const value: ModelCatalog = { providers: [], defaultState: "unknown" };
    const providers = new Map<string, ModelCatalog["providers"][number]>();
    let header = false;
    return {
      append(items) {
        for (const item of items) {
          if (item.kind === "catalog") {
            if (header) throw new Error("Duplicate catalog header");
            header = true;
            value.defaultState = item.defaultState;
            if (item.default) value.default = item.default;
            if (item.defaultVariant) value.defaultVariant = item.defaultVariant;
            if (item.provenance) value.provenance = item.provenance;
          } else if (item.kind === "provider") {
            if (providers.has(item.id)) {
              throw new Error("Duplicate catalog provider");
            }
            const provider = {
              id: item.id,
              name: item.name,
              ...(item.provenance ? { provenance: item.provenance } : {}),
              ...(item.availability ? { availability: item.availability } : {}),
              models: [],
            };
            providers.set(item.id, provider);
            value.providers.push(provider);
          } else {
            const provider = providers.get(item.providerID);
            if (
              !provider ||
              provider.models.some((model) => model.id === item.model.id)
            ) throw new Error("Invalid catalog model identity");
            provider.models.push(item.model);
          }
        }
      },
      finish() {
        if (
          !header || (value.defaultState !== "unknown") !== !!value.default
        ) throw new Error("Invalid catalog default metadata");
        return value;
      },
    };
  },
};
