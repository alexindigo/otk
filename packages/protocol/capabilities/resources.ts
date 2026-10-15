// SPDX-License-Identifier: LGPL-3.0-only
import type { ResourceOption } from "../rpc.ts";
export interface ResourcesCapability {
  listResources(sessionID: string): Promise<ResourceOption[]>;
}
export interface ResourcesCapabilities {
  resources: ResourcesCapability;
}
export const legacyResourcesCapabilities:
  readonly (keyof ResourcesCapabilities)[] = ["resources"];
