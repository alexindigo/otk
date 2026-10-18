// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "./content.ts";

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
      releaseDate?: string;
    }[];
  }[];
  default?: ModelRef;
}

/** Feature-owned contracts, composed by the open RPC interface. */
export interface ModelsRpcMethods {
  "models.list": { params: { sessionID: string }; result: ModelCatalog };
}
