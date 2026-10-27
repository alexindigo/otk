// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.files;
  if (!capability) return;
  rpc.register("find.files", {
    params: (p) => ({
      sessionID: sessionID(p)!,
      query: text(p, "query", true) ?? "",
    }),
    handler: (_ctx, p) => capability.findFiles(p.sessionID, p.query),
  });
}
