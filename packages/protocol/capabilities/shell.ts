// SPDX-License-Identifier: LGPL-3.0-only
import type { ShellInput, SubmissionReceipt } from "../rpc.ts";
import type { OperationContext } from "../requests.ts";
export interface ShellCapability {
  shell(
    input: ShellInput,
    operation?: OperationContext,
  ): Promise<SubmissionReceipt>;
}
export interface ShellCapabilities {
  shell: ShellCapability;
}
export const legacyShellCapabilities: readonly (keyof ShellCapabilities)[] = [
  "shell",
];
