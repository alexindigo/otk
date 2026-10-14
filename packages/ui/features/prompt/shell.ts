// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
export function registerShellPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "shell",
    create: (ctx) => ({
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
          ctx.change((current) => ({ ...current, mode: "shell" }));
          return true;
        }
        if (
          ctx.props.value.mode === "shell" &&
          (event.key === "Escape" ||
            (event.key === "Backspace" && start === 0 && end === 0))
        ) {
          event.preventDefault();
          event.stopPropagation();
          ctx.change((current) => ({ ...current, mode: "normal" }));
          return true;
        }
        return false;
      },
    }),
  });
}
