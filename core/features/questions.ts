// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.questions;
  if (!capability) return;
  rpc.register("question.list", {
    params: (p) => text(p, "sessionID")!,
    handler: (_ctx, id) => capability.listQuestions(id),
  });
  rpc.register("question.reply", {
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
    async handler(_ctx, p) {
      await capability.answerQuestion(p.requestID, p.answers);
      return null;
    },
  });
  rpc.register("question.reject", {
    params: (p) => text(p, "requestID")!,
    async handler(_ctx, id) {
      await capability.answerQuestion(id);
      return null;
    },
  });
}
