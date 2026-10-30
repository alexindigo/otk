// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID } from "../ws/params.ts";
import { HarnessError } from "@otk/harness";
import { readExecution } from "../requests/policies.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.agents;
  if (!capability) return;
  rpc.register("agents.list", {
    execution: readExecution((p: { id: string }) => ({ sessionID: p.id })),
    params: (p) => {
      if (p.primary !== undefined && typeof p.primary !== "boolean") {
        throw new HarnessError("params", "primary must be a boolean");
      }
      return {
        id: sessionID(p)!,
        primary: p.primary as boolean | undefined,
      };
    },
    handler: (ctx, input) =>
      capability.listAgents(input.id, input.primary, ctx.execution?.signal),
  });
}
