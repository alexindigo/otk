// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { PromptHistory } from "../../components/prompt/history.ts";
import { ownedCommand } from "../../keyboard/context.tsx";
export function registerHistoryPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "history",
    create(ctx) {
      const history = new PromptHistory();
      let queue = Promise.resolve();
      const recall = (direction: -1 | 1) => {
        queue = queue.then(async () => {
          const draft = ctx.change((current) => current);
          if (
            !ctx.active() || !ctx.supports("history") ||
            !history.canMove(draft)
          ) return;
          if (history.empty) {
            const entries = await ctx.history();
            if (
              !ctx.active() || ctx.change((current) => current) !== draft
            ) return;
            history.replace(entries);
          }
          const next = history.move(direction, draft);
          if (next) {
            ctx.change(
              (current) =>
                current === draft ? { ...next, agent: current.agent } : current,
              direction === -1 ? 0 : next.input.length,
            );
          }
        }).catch(ctx.fail);
      };
      const previous = ownedCommand(ctx, {
        id: "prompt.history.previous",
        title: "Previous prompt",
        category: "Prompt",
        hidden: true,
        run: () => recall(-1),
      });
      const next = ownedCommand(ctx, {
        id: "prompt.history.next",
        title: "Next prompt",
        category: "Prompt",
        hidden: true,
        run: () => recall(1),
      });
      return {
        submitted: () => history.reset(),
        key(event) {
          const { start, end } = ctx.selection();
          if (
            (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
            event.isComposing || start !== end ||
            !history.canMove(ctx.props.value)
          ) return false;
          const edge = event.key === "ArrowUp"
            ? 0
            : ctx.props.value.input.length;
          if (start !== edge) return false;
          event.preventDefault();
          void (event.key === "ArrowUp" ? previous() : next()).catch(ctx.fail);
          return true;
        },
      };
    },
  });
}
