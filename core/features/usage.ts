// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { readExecution } from "../requests/policies.ts";
export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.usage;
  if (!capability) return;
  rpc.register("usage.get", {
    execution: readExecution((p: { sessionID: string; turnID: string }) => ({
      sessionID: p.sessionID,
      resource: p.turnID,
    })),
    params: (p) => ({ sessionID: sessionID(p)!, turnID: text(p, "turnID")! }),
    handler: (ctx, p) =>
      capability.getUsage(p.sessionID, p.turnID, ctx.execution?.signal),
  });
}
