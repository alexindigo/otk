// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.history;
  if (!capability) return;
  rpc.register("history.list", {
    params: () => undefined,
    handler: () => capability.listHistory(),
  });
  rpc.register("history.attachment", {
    params: (p) => ({
      messageID: text(p, "messageID")!,
      partID: text(p, "partID")!,
    }),
    handler: (_ctx, ref) => capability.attachment(ref),
  });
}
