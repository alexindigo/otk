// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandOption } from "../rpc.ts";
import { arrayCatalogCodec } from "./arrays.ts";
export interface CommandCatalogKinds {
  commands: CommandOption[];
}
export interface CommandChunkKinds {
  commands: CommandOption;
}
export const commandsCatalogCodec = arrayCatalogCodec<"commands">();
