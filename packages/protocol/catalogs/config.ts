// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "../content.ts";
import { arrayCatalogCodec } from "./arrays.ts";
/** Native discovery order, lowest to highest priority. No document bodies or credentials. */
export interface CatalogConfig {
  type: "document" | "directory";
  path?: string;
  order: number;
  model?: ModelRef;
  variant?: string;
  defaultAgent?: string;
}
export interface CatalogProvenance {
  source: "native" | "configuration";
  path?: string;
  order?: number;
}
export interface ConfigCatalogKinds {
  config: CatalogConfig[];
}
export interface ConfigChunkKinds {
  config: CatalogConfig;
}
export const configCatalogCodec = arrayCatalogCodec<"config">();
