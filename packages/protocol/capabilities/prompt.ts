// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptInput } from "../rpc.ts";
export interface PromptCapability {
  prompt(input: PromptInput): Promise<void>;
  abort(sessionID: string): Promise<void>;
}
export interface PromptCapabilities {
  prompt: PromptCapability;
}
export const legacyPromptCapabilities: readonly (keyof PromptCapabilities)[] = [
  "prompt",
];
