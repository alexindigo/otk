// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { PromptPart } from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, text } from "../ws/params.ts";
import { promptParts } from "./prompt-parts.ts";

export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.commands;
  if (!capability) return;
  rpc.register("commands.list", {
    params: (p) => text(p, "sessionID")!,
    handler: (_ctx, id) => capability.listCommands(id),
  });
  rpc.register("session.command", {
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
        sessionID: text(p, "sessionID")!,
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
    async handler(_ctx, input) {
      await capability.command(input);
      return null;
    },
  });
}
