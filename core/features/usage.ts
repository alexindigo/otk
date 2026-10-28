// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID } from "../ws/params.ts";
export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.usage;
  if (!capability) return;
  rpc.register("usage.get", {
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => capability.getUsage(id, ctx.execution?.signal),
  });
}
