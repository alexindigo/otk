// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { PromptInput } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import { promptParts } from "./prompt-parts.ts";
import { nativeEffect, nativeExecution } from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.prompt;
  if (!capability) return;
  const sent = completionReceipt("prompt-sent"),
    interrupted = completionReceipt("interrupt-sent");
  rpc.register("session.prompt", {
    execution: nativeExecution(
      (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
      sent,
    ),
    params(p): PromptInput {
      const parts = promptParts(p.parts);
      if (p.mode !== "normal") {
        throw new HarnessError("params", "Expected normal prompt mode");
      }
      const input: PromptInput = {
        sessionID: sessionID(p)!,
        parts,
        mode: "normal",
        agent: text(p, "agent", true),
        variant: text(p, "variant", true),
      };
      if (p.model !== undefined) {
        const model = object(p.model);
        input.model = {
          provider: text(model, "provider")!,
          model: text(model, "model")!,
        };
      }
      return input;
    },
    handler: (ctx, input) =>
      nativeEffect(ctx, async (operation) => {
        await capability.prompt(input, operation);
        return null;
      }, sent),
  });
  rpc.register("session.abort", {
    execution: {
      ...nativeExecution((id: string) => ({ sessionID: id }), interrupted),
      priority: "interrupt",
    },
    params: (p) => sessionID(p)!,
    handler: (ctx, id) =>
      nativeEffect(ctx, async (operation) => {
        await capability.abort(id, operation);
        return null;
      }, interrupted),
  });
}
