// SPDX-License-Identifier: LGPL-3.0-only
import { RequestMetadataRegistry } from "./request-metadata.ts";
import { coreRequestMetadata } from "./rpc.ts";
import { inboxRequestMetadata } from "./inbox.ts";
import { sessionActionsRequestMetadata } from "./capabilities/session-actions.ts";
import { restoreRequestMetadata } from "./capabilities/restore.ts";
import { modelsRequestMetadata } from "./models.ts";
import { usageRequestMetadata } from "./usage.ts";
import { digestsRequestMetadata } from "./capabilities/digests.ts";
import { approvalsRequestMetadata } from "./approvals.ts";
import { layoutRequestMetadata } from "./preferences/layout.ts";
import { catalogRequestMetadata } from "./catalogs.ts";
/** Shipped composition; the registry itself imports no features. */
export function createRequestMetadata(): RequestMetadataRegistry {
  const registry = new RequestMetadataRegistry();
  for (
    const feature of [
      coreRequestMetadata,
      inboxRequestMetadata,
      sessionActionsRequestMetadata,
      restoreRequestMetadata,
      modelsRequestMetadata,
      usageRequestMetadata,
      digestsRequestMetadata,
      approvalsRequestMetadata,
      layoutRequestMetadata,
      catalogRequestMetadata,
    ]
  ) {
    for (const [method, metadata] of Object.entries(feature)) {
      registry.register(method, metadata);
    }
  }
  return registry;
}
