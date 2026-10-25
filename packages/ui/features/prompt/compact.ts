// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled } from "solid-js";
import type { Selection } from "@otk/client";
import type { PromptContext, PromptRegistry } from "../../registries/prompt.ts";

/** A mounted prompt alone knows the model its next submission would use. */
export function registerCompactCommand(ctx: PromptContext): () => void {
  const available = () =>
    ctx.active() && ctx.props.connected && !ctx.props.suspended &&
    ctx.supports("sessionActions") && !!ctx.compact &&
    !ctx.entry(ctx.sessionID())?.parentID && !!ctx.nextSelection().input.model;
  return ctx.commands.register({
    id: "session.compact",
    title: "Compact",
    category: "Session",
    context: { kind: "session", order: 35 },
    enabled: (context, target?: Selection) =>
      available() && (!target ||
        (target.sessionID === ctx.sessionID() &&
          target.sidecarId === context.sidecar)),
    async run() {
      await ctx.ready();
      if (!ctx.active()) return;
      if (!available()) throw new Error("Compact is no longer available.");
      const model = ctx.nextSelection(ctx.change((draft) => draft)).input.model;
      if (!model) throw new Error("Choose a model before compacting.");
      await ctx.compact!(model);
    },
  });
}
export function registerCompactPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "compact",
    create: (ctx) => {
      onSettled(() => registerCompactCommand(ctx));
      return {};
    },
  });
}
