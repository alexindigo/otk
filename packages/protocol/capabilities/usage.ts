// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionUsage } from "../usage.ts";
export interface UsageCapability {
  getUsage(sessionID: string, signal?: AbortSignal): Promise<SessionUsage>;
}
export interface UsageCapabilities {
  usage: UsageCapability;
}
