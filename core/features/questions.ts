// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import {
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.questions;
  if (!capability) return;
  const answered = completionReceipt("question-replied"),
    rejected = completionReceipt("question-rejected");
  rpc.register("question.list", {
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: (ctx, id) => capability.listQuestions(id, ctx.execution?.signal),
  });
  rpc.register("question.reply", {
    execution: nativeExecution(
      (p: { requestID: string }) => ({ resource: p.requestID }),
      answered,
    ),
    params(p) {
      if (
        !Array.isArray(p.answers) ||
        p.answers.some((values) =>
          !Array.isArray(values) ||
          values.some((value) => typeof value !== "string")
        )
      ) {
        throw new HarnessError("params", "Expected question answer arrays");
      }
      return {
        requestID: text(p, "requestID")!,
        answers: p.answers as string[][],
      };
    },
    handler: (ctx, p) =>
      nativeEffect(ctx, async (operation) => {
        await capability.answerQuestion(p.requestID, p.answers, operation);
        return null;
      }, answered),
  });
  rpc.register("question.reject", {
    execution: nativeExecution((id: string) => ({ resource: id }), rejected),
    params: (p) => text(p, "requestID")!,
    handler: (ctx, id) =>
      nativeEffect(ctx, async (operation) => {
        await capability.answerQuestion(id, undefined, operation);
        return null;
      }, rejected),
  });
}
