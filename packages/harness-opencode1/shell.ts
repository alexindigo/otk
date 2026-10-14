// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError, type ShellCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export type Launch = (
  sessionID: string,
  operation: "shell" | "command",
  path: string,
  options: Parameters<Client["request"]>[1],
) => void;
export function shell(
  client: Client,
  directory: Directory,
  launch: Launch,
): ShellCapability {
  return {
    async shell(input) {
      const dir = await directory.resolve(input.sessionID);
      const agent = input.agent ??
        (await client.json<{ name: string; hidden?: boolean; mode: string }[]>(
          "/agent",
          { query: { directory: dir } },
        )).find((agent) => !agent.hidden && agent.mode !== "subagent")?.name;
      if (!agent) {
        throw new HarnessError(
          "agent",
          "No visible primary agent available",
        );
      }
      launch(
        input.sessionID,
        "shell",
        `/session/${encodeURIComponent(input.sessionID)}/shell`,
        {
          method: "POST",
          query: { directory: dir },
          timeout: null,
          body: {
            command: input.command,
            agent,
            ...(input.model
              ? {
                model: {
                  providerID: input.model.provider,
                  modelID: input.model.model,
                },
              }
              : {}),
          },
        },
      );
    },
  };
}
