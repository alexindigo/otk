// SPDX-License-Identifier: LGPL-3.0-only
import { type CommandsCapability, HarnessError } from "@otk/harness";
import type { AttachmentPolicy, CommandOption } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { Launch } from "./shell.ts";
import { mapPromptParts } from "./prompt.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import type { DirectoryCatalogs } from "./catalogs.ts";
import { nativeCommands } from "./command-vocabulary.ts";
export function commands(
  client: Client,
  directory: Directory,
  launch: Launch,
  catalogs?: DirectoryCatalogs,
  policy?: AttachmentPolicy,
): CommandsCapability {
  return {
    async listCommands(sessionID, signal) {
      const dir = await directory.resolve(sessionID, signal);
      if (catalogs) {
        const [commands, skills] = await Promise.all([
          catalogs.get(dir, "commands", signal),
          catalogs.get(dir, "skills", signal),
        ]);
        return mergeCommands(commands, skills);
      }
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
      return mergeCommands(mapCommands(commands), skills);
    },
    async command(input, operation) {
      const dir = await directory.resolve(input.sessionID);
      if (input.skill) {
        const native = await client.json<{ name: string; source?: string }[]>(
          "/command",
          {
            query: { directory: dir },
            signal: operation?.signal,
          },
        );
        const command = native.find((command) =>
          command.name === input.skill!.name
        );
        if (command?.source !== "skill") {
          throw new HarnessError(
            "command",
            command
              ? skillConflict(input.skill.name)
              : "That skill is no longer available",
          );
        }
      }
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
            command: input.skill?.name ?? input.command,
            arguments: input.arguments,
            agent: input.agent,
            variant: input.variant,
            model: input.model
              ? `${input.model.provider}/${input.model.model}`
              : undefined,
            parts: await mapPromptParts(
              input.parts || [],
              dir,
              operation,
              policy,
            ),
          },
        },
      );
      if (operation && launched) await launched.settled;
    },
  };
}
export function mapCommands(
  commands: { name: string; description?: string; source?: string }[],
): CommandOption[] {
  return [
    ...commands.filter((command) => command.source !== "skill").map((
      command,
    ): CommandOption => ({
      name: command.name,
      description: command.description,
      aliases: [],
      source: command.source === "mcp" ? "mcp" : "server",
      priority: 10,
      skillConflict: skillConflict(command.name),
    })),
    ...nativeCommands(),
  ];
}
function skillConflict(name: string): string {
  return `Shadowed by the server command /${name} in opencode 1.x`;
}
export function mergeCommands(
  commands: CommandOption[],
  skills: { name: string; description?: string }[],
): CommandOption[] {
  return [
    ...commands,
    ...skills.map((skill): CommandOption => ({
      name: skill.name,
      description: skill.description,
      aliases: [],
      source: "skill",
    })),
  ];
}
