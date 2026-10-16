// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, Message } from "@otk/protocol";

/** One projection owns contiguous backend reply identity, content and clocks. */
function replyGroups(
  messages: readonly Message[],
): { firstID: string; lastID: string; message: Message }[] {
  const result: { firstID: string; lastID: string; message: Message }[] = [];
  for (const message of messages) {
    const previous = result.at(-1), group = previous?.message;
    if (
      previous && message.role === "assistant" && group?.role === "assistant" &&
      group.replyTo && group.replyTo === message.replyTo
    ) {
      previous.lastID = message.id;
      previous.message = {
        ...message,
        parts: [...group.parts, ...message.parts],
        interrupted: group.interrupted || message.interrupted,
        error: message.error ?? group.error,
        time: { ...message.time, created: group.time.created },
        cost: group.cost + message.cost,
        tokens: {
          input: group.tokens.input + message.tokens.input,
          output: group.tokens.output + message.tokens.output,
          reasoning: group.tokens.reasoning + message.tokens.reasoning,
          cache: {
            read: group.tokens.cache.read + message.tokens.cache.read,
            write: group.tokens.cache.write + message.tokens.cache.write,
          },
        },
      };
    } else result.push({ firstID: message.id, lastID: message.id, message });
  }
  return result;
}
/** One metadata record at the last step of each contiguous backend reply. */
export function replyMetadata(
  messages: readonly Message[],
): Map<string, AssistantMessage> {
  return new Map(
    replyGroups(messages).flatMap((group) =>
      group.message.role === "assistant"
        ? [[group.lastID, group.message] as const]
        : []
    ),
  );
}
/** Stable first-step keys keep tool and reasoning state mounted as a reply grows. */
export function replyMessages(messages: readonly Message[]): Message[] {
  return replyGroups(messages).map((group) =>
    group.message.id === group.firstID
      ? group.message
      : { ...group.message, id: group.firstID }
  );
}
