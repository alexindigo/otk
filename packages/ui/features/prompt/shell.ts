// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { ownedCommand } from "../../keyboard/context.tsx";
export function registerShellPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "shell",
    create: (ctx) => {
      const enter = ownedCommand(ctx, {
        id: "prompt.shell.enter",
        title: "Enter shell mode",
        category: "Prompt",
        hidden: true,
        run: () => {
          ctx.change((current) => ({ ...current, mode: "shell" }));
        },
      });
      const exit = ownedCommand(ctx, {
        id: "prompt.shell.exit",
        title: "Exit shell mode",
        category: "Prompt",
        hidden: true,
        run: () => {
          ctx.change((current) => ({ ...current, mode: "normal" }));
        },
      });
      ctx.own(
        ctx.keyboard.layer(
          "prompt.shell.exit",
          () => ctx.props.value.mode === "shell" && ctx.focused(),
          5,
        ),
      );
      return {
        enabled: () =>
          ctx.props.value.mode === "shell"
            ? ctx.props.shellEnabled !== false
            : undefined,
        label: () => ctx.props.value.mode === "shell" ? "Shell" : "Prompt",
        placeholder: () =>
          ctx.props.value.mode === "shell"
            ? "Run a shell command…"
            : "Message the agent…",
        key(event) {
          const { start, end } = ctx.selection();
          if (
            event.key === "!" && !event.isComposing &&
            ctx.props.value.mode === "normal" &&
            ctx.props.shellEnabled !== false && start === 0 && end === 0
          ) {
            event.preventDefault();
            event.stopPropagation();
            void enter().catch(ctx.fail);
            return true;
          }
          if (
            ctx.props.value.mode === "shell" &&
            (event.key === "Escape" ||
              (event.key === "Backspace" && start === 0 && end === 0))
          ) {
            event.preventDefault();
            event.stopPropagation();
            void exit().catch(ctx.fail);
            return true;
          }
          return false;
        },
      };
    },
  });
}
