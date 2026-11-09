// SPDX-License-Identifier: LGPL-3.0-only
import type { ResourceOption } from "../rpc.ts";
import { arrayCatalogCodec } from "./arrays.ts";
export interface ResourceCatalogKinds {
  resources: ResourceOption[];
  resourceTemplates: ResourceTemplateOption[];
}
export interface ResourceChunkKinds {
  resources: ResourceOption;
  resourceTemplates: ResourceTemplateOption;
}
export interface ResourceTemplateOption {
  name: string;
  description?: string;
  mime?: string;
  uriTemplate: string;
  server: string;
}
export const resourcesCatalogCodec = arrayCatalogCodec<"resources">();
export const resourceTemplatesCatalogCodec = arrayCatalogCodec<
  "resourceTemplates"
>();
