// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.revert;
  if (!capability) return;
  rpc.register("session.revert", {
    params: (p) => ({
      sessionID: text(p, "sessionID")!,
      messageID: text(p, "messageID")!,
    }),
    handler: (_ctx, p) => capability.revert(p.sessionID, p.messageID),
  });
}
