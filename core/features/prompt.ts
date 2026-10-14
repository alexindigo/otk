// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { PromptInput } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, text } from "../ws/params.ts";
import { promptParts } from "./prompt-parts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.prompt;
  if (!capability) return;
  rpc.register("session.prompt", {
    params(p): PromptInput {
      const parts = promptParts(p.parts);
      if (p.mode !== "normal") {
        throw new HarnessError("params", "Expected normal prompt mode");
      }
      const input: PromptInput = {
        sessionID: text(p, "sessionID")!,
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
    async handler(_ctx, input) {
      await capability.prompt(input);
      return null;
    },
  });
  rpc.register("session.abort", {
    params: (p) => text(p, "sessionID")!,
    async handler(_ctx, id) {
      await capability.abort(id);
      return null;
    },
  });
}
