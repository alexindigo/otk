// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { PromptPart } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import { promptParts } from "./prompt-parts.ts";
import {
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.commands;
  if (!capability) return;
  const receipt = completionReceipt("command-settled");
  rpc.register("commands.list", {
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => capability.listCommands(id, ctx.execution?.signal),
  });
  rpc.register("session.command", {
    execution: nativeExecution(
      (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
      receipt,
    ),
    params(p) {
      const model = p.model === undefined ? undefined : object(p.model),
        parts = p.parts === undefined ||
            (Array.isArray(p.parts) && p.parts.length === 0)
          ? []
          : promptParts(p.parts);
      if (parts.some((part) => part.kind !== "file")) {
        throw new HarnessError(
          "params",
          "Commands accept file attachments only",
        );
      }
      return {
        sessionID: sessionID(p)!,
        command: text(p, "command")!,
        arguments: text(p, "arguments", true) ?? "",
        agent: text(p, "agent", true),
        variant: text(p, "variant", true),
        parts: parts as Extract<PromptPart, { kind: "file" }>[],
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
        await capability.command(input, operation);
        return null;
      }, receipt),
  });
}
