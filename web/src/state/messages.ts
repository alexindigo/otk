// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "@otk/protocol";
export function queuedMessages(
  messages: Message[],
  busy: boolean,
): Set<string> {
  if (!busy) return new Set();
  const pending = messages.findLast((message) =>
    message.role === "assistant" && message.time.completed === undefined
  );
  if (!pending) return new Set();
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.replyTo ? [message.replyTo] : []
    ),
  );
  return new Set(
    messages.filter((message) =>
      message.role === "user" && message.time.created > pending.time.created &&
      !answered.has(message.id)
    ).map((message) => message.id),
  );
}
