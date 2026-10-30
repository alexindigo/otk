// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptInput } from "../rpc.ts";
import type { OperationContext } from "../requests.ts";
export interface PromptCapability {
  prompt(input: PromptInput, operation?: OperationContext): Promise<void>;
  abort(sessionID: string, operation?: OperationContext): Promise<void>;
}
export interface PromptCapabilities {
  prompt: PromptCapability;
}
export const legacyPromptCapabilities: readonly (keyof PromptCapabilities)[] = [
  "prompt",
];
