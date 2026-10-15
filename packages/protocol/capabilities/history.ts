// SPDX-License-Identifier: LGPL-3.0-only
import type { HistoryEntry } from "../history.ts";
import type { PromptPart } from "../rpc.ts";
export interface HistoryAttachmentRef {
  messageID: string;
  partID: string;
}
export interface HistoryCapability {
  listHistory(): Promise<HistoryEntry[]>;
  attachment(
    ref: HistoryAttachmentRef,
  ): Promise<Extract<PromptPart, { source: "upload" }>>;
}
export interface HistoryCapabilities {
  history: HistoryCapability;
}
export const legacyHistoryCapabilities: readonly (keyof HistoryCapabilities)[] =
  ["history"];
