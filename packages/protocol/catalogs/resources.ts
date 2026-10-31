// SPDX-License-Identifier: LGPL-3.0-only
import type { ResourceOption } from "../rpc.ts";
import { arrayCatalogCodec } from "./arrays.ts";
export interface ResourceCatalogKinds {
  resources: ResourceOption[];
}
export interface ResourceChunkKinds {
  resources: ResourceOption;
}
export const resourcesCatalogCodec = arrayCatalogCodec<"resources">();
