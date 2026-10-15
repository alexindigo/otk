// SPDX-License-Identifier: LGPL-3.0-only
import type { ShellInput } from "../rpc.ts";
export interface ShellCapability {
  shell(input: ShellInput): Promise<void>;
}
export interface ShellCapabilities {
  shell: ShellCapability;
}
export const legacyShellCapabilities: readonly (keyof ShellCapabilities)[] = [
  "shell",
];
