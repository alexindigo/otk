// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, Message } from "@otk/protocol";
import { projectReplies } from "./transcript-projection.ts";

/** Detached, one-shot compatibility helpers use the canonical grouping primitives. */
export function replyMetadata(
  messages: readonly Message[],
): Map<string, AssistantMessage> {
  return new Map(
    projectReplies(messages).flatMap((group) => {
      return group.message.role === "assistant"
        ? [[group.lastID, group.message] as const]
        : [];
    }),
  );
}
export type ReplyMessage = Message & { lastID: string; pending?: boolean };
export function replyMessages(
  messages: readonly Message[],
  busy = false,
): ReplyMessage[] {
  return projectReplies(messages, busy).map((group) => {
    return {
      ...group.message,
      id: group.firstID,
      lastID: group.lastID,
      pending: !!group.pending,
    };
  });
}
