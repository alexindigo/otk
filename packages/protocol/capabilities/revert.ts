// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "../content.ts";
import type { OperationContext } from "../requests.ts";
export interface RevertCapability {
  revert(
    sessionID: string,
    messageID: string,
    operation?: OperationContext,
  ): Promise<ContentSession>;
}
export interface RevertCapabilities {
  revert: RevertCapability;
}
export const legacyRevertCapabilities: readonly (keyof RevertCapabilities)[] = [
  "revert",
];
