// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelCatalog } from "@otk/protocol";
import type { StateFactory } from "./state.ts";
import {
  type CatalogConnection,
  type CatalogOwner,
  createCatalogResource,
} from "./catalog-resource.ts";

export type { CatalogState } from "./catalog-resource.ts";
export type ModelCatalogConnection = CatalogConnection;
export type ModelCatalogOwner = CatalogOwner<ModelCatalog>;

/** One session/directory's model data, borrowed by meter and composer. */
export function createModelCatalog(options: {
  connection(): ModelCatalogConnection;
  load(signal: AbortSignal): Promise<ModelCatalog>;
  factory?: StateFactory;
}): ModelCatalogOwner {
  return createCatalogResource(options);
}
