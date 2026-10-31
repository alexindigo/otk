// SPDX-License-Identifier: LGPL-3.0-only
import type { HistoryEntry } from "../history.ts";
import type { PromptPart } from "../rpc.ts";
export interface HistoryAttachmentRef {
  messageID: string;
  partID: string;
}
export interface HistoryAttachment {
  ref: HistoryAttachmentRef;
  part: Extract<PromptPart, { source: "upload" }>;
}
export interface HistoryCapability {
  listHistory(signal?: AbortSignal): Promise<HistoryEntry[]>;
  attachments(
    refs: HistoryAttachmentRef[],
    signal?: AbortSignal,
  ): Promise<HistoryAttachment[]>;
  attachment(
    ref: HistoryAttachmentRef,
    signal?: AbortSignal,
  ): Promise<Extract<PromptPart, { source: "upload" }>>;
}
export interface HistoryCapabilities {
  history: HistoryCapability;
}
export const legacyHistoryCapabilities: readonly (keyof HistoryCapabilities)[] =
  ["history"];
