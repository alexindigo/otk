// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";
import { readExecution } from "../requests/policies.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.history;
  if (!capability) return;
  rpc.register("history.list", {
    execution: readExecution(() => ({ resource: "prompt-history" })),
    params: () => undefined,
    handler: (ctx) => capability.listHistory(ctx.execution?.signal),
  });
  rpc.register("history.attachment", {
    execution: readExecution((ref: { messageID: string; partID: string }) => ({
      resource: JSON.stringify([ref.messageID, ref.partID]),
    })),
    params: (p) => ({
      messageID: text(p, "messageID")!,
      partID: text(p, "partID")!,
    }),
    handler: (ctx, ref) => capability.attachment(ref, ctx.execution?.signal),
  });
}
