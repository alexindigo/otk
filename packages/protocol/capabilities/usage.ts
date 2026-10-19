// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionUsage } from "../usage.ts";
export interface UsageCapability {
  getUsage(sessionID: string): Promise<SessionUsage>;
}
export interface UsageCapabilities {
  usage: UsageCapability;
}
