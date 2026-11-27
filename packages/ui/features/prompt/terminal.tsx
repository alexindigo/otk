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
      const command = "prompt.terminal";
      ownedCommand(ctx, {
        id: command,
        title: "Toggle terminal",
        category: "Prompt",
        context: { kind: "composer", order: 31 },
        enabled: () => !ctx.props.suspended,
        run: () => box().toggle(),
      });
      const label = () =>
        box().mode === "closed" ? "Open terminal" : "Hide terminal";
      const action = ctx.commands.control(command, undefined, {
        target: { label: "Terminal" },
        shown: () => true, // The box owner synchronously accepts the toggle.
        unshown: "The terminal box did not change.",
        recovery: "Try toggling the terminal box again",
      });
      return {
        action: () => ({
          key: "terminal",
          label,
          icon: () => <TerminalIcon />,
          control: action,
          expanded: () => box().mode !== "closed",
        }),
      };
    },
  });
}
