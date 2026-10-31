// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentOption } from "../rpc.ts";
import { arrayCatalogCodec } from "./arrays.ts";
export interface CatalogAgent extends AgentOption {
  primary: boolean;
  mention: boolean;
}
export interface AgentCatalogKinds {
  agents: CatalogAgent[];
}
export interface AgentChunkKinds {
  agents: CatalogAgent;
}
export const agentsCatalogCodec = arrayCatalogCodec<"agents">();
