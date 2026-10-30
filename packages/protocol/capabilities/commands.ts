// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandInput, CommandOption } from "../rpc.ts";
import type { OperationContext } from "../requests.ts";
export interface CommandsCapability {
  command(input: CommandInput, operation?: OperationContext): Promise<void>;
  listCommands(sessionID: string): Promise<CommandOption[]>;
}
export interface CommandsCapabilities {
  commands: CommandsCapability;
}
export const legacyCommandsCapabilities:
  readonly (keyof CommandsCapabilities)[] = ["commands"];
