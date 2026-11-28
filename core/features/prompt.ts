// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { PromptInput } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import { promptParts } from "./prompt-parts.ts";
import {
  metadataReceipt,
  nativeEffect,
  nativeExecution,
} from "../requests/policies.ts";
import {
  completionReceipt,
  promptSelectionReceipt,
  sentPromptReceipt,
} from "./session-receipts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.prompt;
  if (!capability) return;
  const sent = sentPromptReceipt,
    interrupted = completionReceipt("interrupt-sent");
  rpc.register("session.prompt", {
    execution: {
      ...nativeExecution(
        (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
        sent,
      ),
      checkpoint: (receipt) =>
        receipt.kind === promptSelectionReceipt.kind
          ? promptSelectionReceipt.validate(receipt)
          : sent.validate(receipt),
    },
    params(p): PromptInput {
      const parts = promptParts(p.parts);
      if (p.mode !== "normal") {
        throw new HarnessError("params", "Expected normal prompt mode");
      }
      const input: PromptInput = {
        sessionID: sessionID(p)!,
        messageID: text(p, "messageID", true),
        parts,
        mode: "normal",
        agent: text(p, "agent", true),
        variant: text(p, "variant", true),
      };
      if (
        input.messageID && !/^msg_[a-zA-Z0-9]{20,40}$/.test(input.messageID)
      ) {
        throw new HarnessError("params", "Invalid prompt message identity");
      }
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
        return await capability.prompt(input, operation) ?? null;
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
  const withdraw = capability.withdraw?.bind(capability);
  const withdrawal = metadataReceipt("prompt-withdrawal", (value) => {
    const { state } = object(value);
    if (
      state !== "withdrawn" && state !== "started" && state !== "absent" &&
      state !== "unconfirmed"
    ) {
      throw new TypeError("Invalid withdrawal receipt");
    }
    return { state };
  });
  rpc.register("session.withdraw", {
    execution: {
      ...nativeExecution(
        (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
        withdrawal,
      ),
      priority: "interrupt",
    },
    params: (p) => ({
      sessionID: sessionID(p)!,
      messageID: text(p, "messageID")!,
    }),
    handler: (ctx, input) =>
      nativeEffect(
        ctx,
        (operation) =>
          withdraw?.(input.sessionID, input.messageID, operation) ??
            Promise.resolve({ state: "unconfirmed" }),
        withdrawal,
      ),
  });
}
