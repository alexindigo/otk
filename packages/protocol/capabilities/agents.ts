// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentOption } from "../rpc.ts";
export interface AgentsCapability {
  listAgents(sessionID: string, primary?: boolean): Promise<AgentOption[]>;
}
export interface AgentsCapabilities {
  agents: AgentsCapability;
}
export const legacyAgentsCapabilities: readonly (keyof AgentsCapabilities)[] = [
  "agents",
];
