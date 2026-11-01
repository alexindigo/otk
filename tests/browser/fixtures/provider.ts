// SPDX-License-Identifier: LGPL-3.0-only
/** Observe exact user bytes at the real scripted provider, excluding title prompts. */
export function receivedPrompt(requests: unknown[], prompt: string): boolean {
  return requests.some((request) => {
    const messages =
      (request as { messages?: { role: string; content: unknown }[] }).messages;
    return messages?.some((message) =>
      message.role === "user" && (
        message.content === prompt ||
        (Array.isArray(message.content) && message.content.some(
          (part) => part?.type === "text" && part.text === prompt,
        ))
      )
    ) ?? false;
  });
}
