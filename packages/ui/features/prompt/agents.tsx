// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { ownedCommand } from "../../keyboard/context.tsx";
/** Essential cycling only. Agent data and selected draft belong to the consumer. */
export function registerAgentCyclePrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "agent-cycle",
    create(ctx) {
      let queue = Promise.resolve();
      const cycle = (delta: number) => {
        const task = queue.then(async () => {
          if (!ctx.active()) return;
          const draft = ctx.change((current) => current);
          if (!ctx.supports("agents")) return;
          const agents = await ctx.rpc("agents.list", {
            sessionID: ctx.sessionID(),
            primary: true,
          });
          if (
            !ctx.active() || !ctx.props.connected ||
            !ctx.supports("agents") || !agents.length
          ) return;
          ctx.change((current) => {
            if (current.agent !== draft.agent) return current;
            // Native primary-list order puts the configured default first.
            // An unset or no-longer-visible selection starts at that default.
            const at = Math.max(
              0,
              agents.findIndex((agent) => agent.name === current.agent),
            );
            return {
              ...current,
              agent: agents[(at + delta + agents.length) % agents.length].name,
            };
          });
        });
        queue = task.catch(() => {});
        return task;
      };
      const enabled = () =>
        !ctx.props.suspended && ctx.props.connected && ctx.supports("agents");
      ownedCommand(ctx, {
        id: "agent.cycle",
        title: "Next agent",
        category: "Prompt",
        enabled,
        run: () => cycle(1),
      });
      ownedCommand(ctx, {
        id: "agent.cycle.reverse",
        title: "Previous agent",
        category: "Prompt",
        enabled,
        run: () => cycle(-1),
      });
      onSettled(() => {
        const next = ctx.keyboard.keymap.bind({
          id: "agent.cycle",
          command: "agent.cycle",
          key: "Tab",
          inPrompt: true,
          ctx: "prompt",
        }, ctx.focused);
        const previous = ctx.keyboard.keymap.bind({
          id: "agent.cycle.reverse",
          command: "agent.cycle.reverse",
          key: "Shift+Tab",
          inPrompt: true,
          ctx: "prompt",
        }, ctx.focused);
        return () => {
          next();
          previous();
        };
      });
      return {};
    },
  });
}
