// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";
export const modelsRequestMetadata: Readonly<Record<string, RequestMetadata>> =
  { "models.list": { kind: "read", pending: "Loading models" } };
import type { ModelRef } from "./content.ts";
import type { CatalogProvenance } from "./catalogs/config.ts";

/** USD per million tokens; zero is a known free rate, absence is unknown. */
export interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}
export interface ModelCostTier extends ModelCost {
  tier?: { type: "context"; size: number };
}

/** Public catalog metadata only; provider credentials and options stay native. */
export interface ModelCatalog {
  providers: {
    id: string;
    name: string;
    provenance?: CatalogProvenance[];
    availability?: "automatic" | "enabled" | "disabled";
    models: {
      id: string;
      name: string;
      variants: string[];
      status: "alpha" | "beta" | "active" | "deprecated";
      free: boolean | null;
      /** Reported context window; absent when the backend does not know it. */
      contextLimit?: number;
      cost?: ModelCost;
      costs?: ModelCostTier[];
      provenance?: CatalogProvenance[];
      releaseDate?: string;
    }[];
  }[];
  defaultState: "configured" | "applied" | "unknown";
  default?: ModelRef;
  defaultVariant?: string;
  provenance?: CatalogProvenance[];
}

/** Feature-owned contracts, composed by the open RPC interface. */
export interface ModelsRpcMethods {
  "models.list": { params: { sessionID: string }; result: ModelCatalog };
}
