// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.models;
  if (!capability) return;
  rpc.register("models.list", {
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => capability.listModels(id, ctx.execution?.signal),
  });
}
