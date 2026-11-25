// SPDX-License-Identifier: LGPL-3.0-only
import { nativeModel } from "./selection.ts";
import { HarnessError, type ShellCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { ErrorRequest } from "./errors.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { submissionID } from "./submission-id.ts";
export interface NativeLaunch {
  admitted: Promise<void>;
  settled: Promise<void>;
}
export type Launch = (
  sessionID: string,
  operation: NonNullable<ErrorRequest["operation"]>,
  path: string,
  options: Parameters<Client["request"]>[1],
) => NativeLaunch | void;
export function shell(
  client: Client,
  directory: Directory,
  launch: Launch,
): ShellCapability {
  return {
    async shell(input, operation) {
      const messageID = input.messageID ?? submissionID();
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
      const launched = launch(
        input.sessionID,
        "shell",
        `/session/${encodeURIComponent(ids.decode(input.sessionID))}/shell`,
        {
          method: "POST",
          query: { directory: dir },
          classification: "effect",
          ...(operation ? { operation } : {}),
          body: {
            messageID,
            command: input.command,
            agent,
            ...(input.model ? { model: nativeModel(input.model) } : {}),
          },
        },
      );
      if (operation && launched) await launched.settled;
      return { messageID, state: "started" };
    },
  };
}
