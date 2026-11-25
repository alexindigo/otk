// SPDX-License-Identifier: LGPL-3.0-only
import { codeCopyText, type CommandHub } from "@otk/client";
import { copyText } from "../clipboard.ts";
import type { ContentTarget } from "./transcript-context.tsx";

export function registerCodeBlockCommands(
  commands: CommandHub,
): () => void {
  return commands.register({
    id: "code.copy",
    title: "Copy code",
    category: "Transcript",
    arguments: { type: "object" },
    context: { kind: "code" },
    enabled: (_context, target?: ContentTarget) => !!target?.code,
    run: (_context, target: ContentTarget) =>
      copyText(codeCopyText(target.code!), {
        actionLabel: "Copy code",
        target: "Code block",
        recovery: "Select the code and press Ctrl+C (Cmd+C on macOS).",
      }),
  });
}
