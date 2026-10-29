// SPDX-License-Identifier: LGPL-3.0-only
import type { TurnUsageDetail } from "../usage.ts";
export interface UsageCapability {
  getUsage(
    sessionID: string,
    turnID: string,
    signal?: AbortSignal,
  ): Promise<TurnUsageDetail>;
}
export interface UsageCapabilities {
  usage: UsageCapability;
}
