// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { OperationContext, PermissionReply } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import {
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";

export function register(
  rpc: RpcRegistry,
  harness: Harness,
  reply?: (
    input: PermissionReply,
    operation?: OperationContext,
  ) => Promise<void>,
): void {
  const capability = harness.capabilities.permissions;
  if (!capability) return;
  const receipt = completionReceipt("permission-replied");
  rpc.register("permission.list", {
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => capability.listPermissions(id, ctx.execution?.signal),
  });
  rpc.register("permission.reply", {
    execution: nativeExecution(
      (p: PermissionReply) => ({
        sessionID: p.sessionID,
        resource: p.requestID,
      }),
      receipt,
    ),
    params(p): PermissionReply {
      const reply = p.reply;
      if (reply !== "once" && reply !== "always" && reply !== "reject") {
        throw new HarnessError("params", "Invalid permission reply");
      }
      return {
        sessionID: sessionID(p)!,
        requestID: text(p, "requestID")!,
        reply,
        message: text(p, "message", true),
      };
    },
    handler: (ctx, input) =>
      nativeEffect(ctx, async (operation) => {
        await (reply
          ? reply(input, operation)
          : capability.replyPermission(input, operation));
        return null;
      }, receipt),
  });
}
