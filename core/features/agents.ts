// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";
import { HarnessError } from "@otk/harness";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.agents;
  if (!capability) return;
  rpc.register("agents.list", {
    params: (p) => {
      if (p.primary !== undefined && typeof p.primary !== "boolean") {
        throw new HarnessError("params", "primary must be a boolean");
      }
      return {
        id: text(p, "sessionID")!,
        primary: p.primary as boolean | undefined,
      };
    },
    handler: (_ctx, input) => capability.listAgents(input.id, input.primary),
  });
}
