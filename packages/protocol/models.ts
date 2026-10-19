// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "./content.ts";

/** USD per million tokens; zero is a known free rate, absence is unknown. */
export interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

/** Public catalog metadata only; provider credentials and options stay native. */
export interface ModelCatalog {
  providers: {
    id: string;
    name: string;
    models: {
      id: string;
      name: string;
      variants: string[];
      status: "alpha" | "beta" | "active" | "deprecated";
      free: boolean;
      /** Reported context window; absent when the backend does not know it. */
      contextLimit?: number;
      cost?: ModelCost;
      releaseDate?: string;
    }[];
  }[];
  default?: ModelRef;
}

/** Feature-owned contracts, composed by the open RPC interface. */
export interface ModelsRpcMethods {
  "models.list": { params: { sessionID: string }; result: ModelCatalog };
}
