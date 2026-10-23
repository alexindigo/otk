// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { createPromptHistory } from "@otk/client";
import { ownedCommand } from "../../keyboard/context.tsx";
export function registerHistoryPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "history",
    create(ctx) {
      const history = createPromptHistory({
        available: () => ctx.active() && ctx.supports("history"),
        load: () => ctx.history(),
        change: (update, caret) => ctx.change(update, caret),
        fail: (error) => ctx.fail(error),
      });
      ctx.own(() => history.dispose());
      const previous = ownedCommand(ctx, {
        id: "prompt.history.previous",
        title: "Previous prompt",
        category: "Prompt",
        hidden: true,
        run: () => history.recall(-1),
      });
      const next = ownedCommand(ctx, {
        id: "prompt.history.next",
        title: "Next prompt",
        category: "Prompt",
        hidden: true,
        run: () => history.recall(1),
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
