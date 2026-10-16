// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, Message } from "@otk/protocol";

/** One metadata record at the last step of each contiguous backend reply. */
export function replyMetadata(
  messages: readonly Message[],
): Map<string, AssistantMessage> {
  const result = new Map<string, AssistantMessage>();
  let group: AssistantMessage | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") {
      group = undefined;
      continue;
    }
    if (group && group.replyTo && group.replyTo === message.replyTo) {
      result.delete(group.id);
      group = {
        ...message,
        interrupted: group.interrupted || message.interrupted,
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
    } else group = message;
    result.set(message.id, group);
  }
  return result;
}
