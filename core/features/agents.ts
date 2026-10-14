// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.agents;
  if (!capability) return;
  rpc.register("agents.list", {
    params: (p) => text(p, "sessionID")!,
    handler: (_ctx, id) => capability.listAgents(id),
  });
}
