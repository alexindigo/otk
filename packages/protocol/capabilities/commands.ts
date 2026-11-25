// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandInput, CommandOption, SubmissionReceipt } from "../rpc.ts";
import type { OperationContext } from "../requests.ts";
export interface CommandsCapability {
  command(
    input: CommandInput,
    operation?: OperationContext,
  ): Promise<SubmissionReceipt>;
  listCommands(
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<CommandOption[]>;
}
export interface CommandsCapabilities {
  commands: CommandsCapability;
}
export const legacyCommandsCapabilities:
  readonly (keyof CommandsCapabilities)[] = ["commands"];
