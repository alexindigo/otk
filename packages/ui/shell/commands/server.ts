// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CommandHub,
  SERVER_RELOAD,
  type SidecarConnection,
} from "@otk/client";

export function registerServerCommands(
  commands: CommandHub,
  connection: (id: string) => SidecarConnection,
): () => void {
  return commands.register({
    id: SERVER_RELOAD,
    title: "Reload OTK",
    category: "Server",
    arguments: {
      type: "object",
      properties: { sidecarId: { type: "string" } },
    },
    run: (_ctx, input: { sidecarId: string }) =>
      connection(input.sidecarId).reload(),
  });
}
