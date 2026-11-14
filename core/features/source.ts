// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { readExecution } from "../requests/policies.ts";
export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.source;
  if (!capability) return;
  rpc.register("source.get", {
    execution: readExecution((p: { sessionID: string; ref: string }) => ({
      sessionID: p.sessionID,
      resource: p.ref,
    })),
    params: (p) => ({ sessionID: sessionID(p)!, ref: text(p, "ref")! }),
    handler: (ctx, p) =>
      capability.getSource(p.sessionID, p.ref, ctx.execution?.signal),
  });
}
