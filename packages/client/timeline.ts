// SPDX-License-Identifier: LGPL-3.0-only
import type { Message, Part } from "@otk/protocol";
import { queuedMessages } from "./messages.ts";

export interface TimelinePrompt {
  id: string;
  time: number;
  queued: boolean;
  /** Borrowed source parts; presentation belongs to the consumer's registry. */
  parts: Part[];
}

/** A projection of the loaded transcript, never another content store. */
export function timelinePrompts(
  messages: readonly Message[],
  busy = false,
): TimelinePrompt[] {
  const queued = queuedMessages(messages, busy);
  return messages.filter((message) => message.role === "user").map((
    message,
  ) => ({
    id: message.id,
    time: message.time.created,
    queued: queued.has(message.id),
    parts: message.parts,
  }));
}
