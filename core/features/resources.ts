// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID } from "../ws/params.ts";
import { readExecution } from "../requests/policies.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.resources;
  if (!capability) return;
  rpc.register("resources.list", {
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => capability.listResources(id, ctx.execution?.signal),
  });
}
