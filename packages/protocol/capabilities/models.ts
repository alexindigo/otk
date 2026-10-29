// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelCatalog } from "../models.ts";

export interface ModelsCapability {
  listModels(sessionID: string, signal?: AbortSignal): Promise<ModelCatalog>;
}
export interface ModelsCapabilities {
  models: ModelsCapability;
}
