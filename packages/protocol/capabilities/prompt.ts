// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptInput, PromptReceipt, WithdrawReceipt } from "../rpc.ts";
import type { OperationContext } from "../requests.ts";
export interface PromptCapability {
  prompt(
    input: PromptInput,
    operation?: OperationContext,
  ): Promise<PromptReceipt | void>;
  abort(sessionID: string, operation?: OperationContext): Promise<void>;
  withdraw?(
    sessionID: string,
    messageID: string,
    operation?: OperationContext,
  ): Promise<WithdrawReceipt>;
}
export interface PromptCapabilities {
  prompt: PromptCapability;
}
export const legacyPromptCapabilities: readonly (keyof PromptCapabilities)[] = [
  "prompt",
];
