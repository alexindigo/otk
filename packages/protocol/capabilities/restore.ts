// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "../request-metadata.ts";
export const restoreRequestMetadata: Readonly<Record<string, RequestMetadata>> =
  { "session.restore": { kind: "mutation", pending: "Restoring" } };
import type { ContentSession } from "../content.ts";
import type { OperationContext } from "../requests.ts";
export interface RestoreCapability {
  restore(
    sessionID: string,
    operation?: OperationContext,
  ): Promise<ContentSession>;
}
export interface RestoreCapabilities {
  restore: RestoreCapability;
}
export interface RestoreRpcMethods {
  "session.restore": { params: { sessionID: string }; result: ContentSession };
}
