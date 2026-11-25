// SPDX-License-Identifier: LGPL-3.0-only
import {
  codeCopyText,
  codeRunAvailability,
  codeRunText,
  type CommandHub,
  type SidecarConnection,
  TERMINAL_RUN_LABEL,
  terminalBoxFor,
} from "@otk/client";
import { copyText } from "../clipboard.ts";
import type { ContentTarget } from "./transcript-context.tsx";
import { solidState } from "../state/binding.ts";

export function registerCodeBlockCommands(
  commands: CommandHub,
  connection: (id: string) => SidecarConnection,
): () => void {
  const copy = commands.register({
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
  const box = (target: ContentTarget) =>
    target.sessionID
      ? terminalBoxFor(
        connection(target.sidecarId ?? "local"),
        target.sessionID,
        solidState,
      )
      : undefined;
  const run = commands.register({
    id: "code.run",
    title: TERMINAL_RUN_LABEL,
    category: "Transcript",
    arguments: { type: "object" },
    context: { kind: "code", order: 1 },
    availability: (_context, target?: ContentTarget) => {
      if (!target?.code || codeRunText(target.code) === undefined) {
        return {
          available: false,
          hidden: true,
          reason: "This block is not a shell command",
        };
      }
      return codeRunAvailability({
        source: target.code,
        sessionID: target.sessionID,
        unavailable: box(target)?.unavailable,
      });
    },
    run: (_context, target: ContentTarget) =>
      box(target)!.run(codeRunText(target.code!)!),
  });
  return () => {
    run();
    copy();
  };
}
