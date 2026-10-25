// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "../content.ts";
export interface RestoreCapability {
  restore(sessionID: string): Promise<ContentSession>;
}
export interface RestoreCapabilities {
  restore: RestoreCapability;
}
export interface RestoreRpcMethods {
  "session.restore": { params: { sessionID: string }; result: ContentSession };
}
