// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { PermissionReply } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(
  rpc: RpcRegistry,
  harness: Harness,
  reply?: (input: PermissionReply) => Promise<void>,
): void {
  const capability = harness.capabilities.permissions;
  if (!capability) return;
  rpc.register("permission.list", {
    params: (p) => text(p, "sessionID")!,
    handler: (_ctx, id) => capability.listPermissions(id),
  });
  rpc.register("permission.reply", {
    params(p): PermissionReply {
      if (!["once", "always", "reject"].includes(String(p.reply))) {
        throw new HarnessError("params", "Invalid permission reply");
      }
      return {
        sessionID: text(p, "sessionID")!,
        requestID: text(p, "requestID")!,
        reply: p.reply as "once" | "always" | "reject",
        message: text(p, "message", true),
      };
    },
    async handler(_ctx, input) {
      await (reply ? reply(input) : capability.replyPermission(input));
      return null;
    },
  });
}
