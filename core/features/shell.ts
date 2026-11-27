// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import { nativeEffect, nativeExecution } from "../requests/policies.ts";
import { completionReceipt, submissionReceipt } from "./session-receipts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const termination = harness.capabilities["shell.terminate"];
  if (termination) {
    const receipt = completionReceipt("shell-terminated");
    rpc.register("shell.terminate", {
      execution: {
        ...nativeExecution((p: { sessionID: string }) => ({
          sessionID: p.sessionID,
        }), receipt),
        priority: "interrupt",
      },
      params: (p) => ({
        sessionID: sessionID(p)!,
        shellID: text(p, "shellID")!,
      }),
      handler: (ctx, { sessionID, shellID }) =>
        nativeEffect(ctx, async (operation) => {
          await termination.terminate(sessionID, shellID, operation);
          return null;
        }, receipt),
    });
  }
  const capability = harness.capabilities.shell;
  if (!capability) return;
  const receipt = submissionReceipt("shell-settled");
  rpc.register("session.shell", {
    execution: nativeExecution(
      (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
      receipt,
    ),
    params(p) {
      const model = p.model === undefined ? undefined : object(p.model);
      return {
        sessionID: sessionID(p)!,
        ...(p.messageID === undefined
          ? {}
          : { messageID: text(p, "messageID")! }),
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
      nativeEffect(
        ctx,
        (operation) => capability.shell(input, operation),
        receipt,
      ),
  });
}
