// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { ownedCommand } from "../../keyboard/context.tsx";
import { TerminalIcon } from "../../components/ChromeIcons.tsx";
import { useShellPorts } from "../../shell/context.tsx";
import { terminalBoxFor } from "@otk/client";
import { solidState } from "../../state/binding.ts";

export function registerTerminalPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "terminal",
    create(ctx) {
      const shell = useShellPorts();
      const box = () =>
        terminalBoxFor(
          shell.connection(shell.selection()!.sidecarId),
          ctx.sessionID(),
          solidState,
        );
      const open = ownedCommand(ctx, {
        id: "prompt.terminal",
        title: "Toggle terminal",
        category: "Prompt",
        context: { kind: "composer", order: 31 },
        enabled: () => !ctx.props.suspended,
        run: () => box().toggle(),
      });
      return {
        actions: () => (
          <button
            type="button"
            class="otk-icon-button"
            aria-label={box().mode === "closed"
              ? "Open terminal"
              : "Hide terminal"}
            title={box().mode === "closed" ? "Open terminal" : "Hide terminal"}
            aria-expanded={box().mode !== "closed" ? "true" : "false"}
            onClick={() => void open().catch(ctx.fail)}
          >
            <TerminalIcon />
          </button>
        ),
      };
    },
  });
}
