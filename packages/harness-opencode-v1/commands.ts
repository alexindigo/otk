// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandsCapability } from "@otk/harness";
import type { CommandOption } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { Launch } from "./shell.ts";
import { mapPromptParts } from "./prompt.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
export function commands(
  client: Client,
  directory: Directory,
  launch: Launch,
): CommandsCapability {
  return {
    async listCommands(sessionID, signal) {
      const dir = await directory.resolve(sessionID, signal);
      const [commands, skills] = await Promise.all([
        client.json<{ name: string; description?: string; source?: string }[]>(
          "/command",
          { query: { directory: dir }, signal },
        ),
        client.json<{ name: string; description?: string }[]>("/skill", {
          query: { directory: dir },
          signal,
        }),
      ]);
      const result = new Map<string, CommandOption>();
      for (const command of commands) {
        result.set(command.name, {
          name: command.name,
          description: command.description,
          aliases: [],
          source: command.source === "mcp"
            ? "mcp"
            : command.source === "skill"
            ? "skill"
            : "server",
        });
      }
      for (const skill of skills) {
        if (!result.has(skill.name)) {
          result.set(skill.name, {
            name: skill.name,
            description: skill.description,
            aliases: [],
            source: "skill",
          });
        }
      }
      return [...result.values()];
    },
    async command(input, operation) {
      const dir = await directory.resolve(input.sessionID);
      const launched = launch(
        input.sessionID,
        "command",
        `/session/${encodeURIComponent(ids.decode(input.sessionID))}/command`,
        {
          method: "POST",
          query: { directory: dir },
          classification: "effect",
          ...(operation ? { operation } : {}),
          body: {
            command: input.command,
            arguments: input.arguments,
            agent: input.agent,
            variant: input.variant,
            model: input.model
              ? `${input.model.provider}/${input.model.model}`
              : undefined,
            parts: await mapPromptParts(input.parts || [], dir, operation),
          },
        },
      );
      if (operation && launched) await launched.settled;
    },
  };
}
