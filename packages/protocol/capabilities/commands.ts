// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandInput, CommandOption } from "../rpc.ts";
export interface CommandsCapability {
  command(input: CommandInput): Promise<void>;
  listCommands(sessionID: string): Promise<CommandOption[]>;
}
export interface CommandsCapabilities {
  commands: CommandsCapability;
}
export const legacyCommandsCapabilities:
  readonly (keyof CommandsCapabilities)[] = ["commands"];
