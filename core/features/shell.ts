// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import { nativeEffect, nativeExecution } from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.shell;
  if (!capability) return;
  const receipt = completionReceipt("shell-settled");
  rpc.register("session.shell", {
    execution: nativeExecution(
      (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
      receipt,
    ),
    params(p) {
      const model = p.model === undefined ? undefined : object(p.model);
      return {
        sessionID: sessionID(p)!,
        command: text(p, "command")!,
        agent: text(p, "agent", true),
        ...(model
          ? {
            model: {
              provider: text(model, "provider")!,
              model: text(model, "model")!,
            },
          }
          : {}),
      };
    },
    handler: (ctx, input) =>
      nativeEffect(ctx, async (operation) => {
        await capability.shell(input, operation);
        return null;
      }, receipt),
  });
}
