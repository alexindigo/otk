// SPDX-License-Identifier: LGPL-3.0-only
import type { Message, Part, TurnTiming } from "@otk/protocol";
import { duration } from "@otk/client";
export { createMessageLayout } from "./message-layout.ts";

import type { PartPresentation } from "../registries/renderers.ts";
export type { WorkTime } from "../registries/renderers.ts";
export interface PartGroup {
  id: string;
  parts: Part[];
  work: boolean;
  required?: boolean;
}
export interface PartFrame {
  id: string;
  parts: Part[];
  transcript: boolean;
}
type FramedMessage = Pick<Message, "id" | "role" | "parts"> & {
  origin?: Extract<Message, { role: "user" }>["origin"];
};
/** Provider context is visible content, never a user prompt or prompt action. */
export function messageLayoutRole(
  message: Pick<FramedMessage, "role" | "origin">,
): "user" | "assistant" | "context" {
  return message.role === "assistant"
    ? "assistant"
    : message.role === "user" && message.origin === undefined
    ? "user"
    : "context";
}
/** Feature-owned framing is separate from work grouping; mixed messages keep
 * ordinary adjacent content together without enclosing transcript markers. */
export function partFrames(
  parts: Part[],
  presentation: (part: Part) => PartPresentation,
  reply = false,
): PartFrame[] {
  const frames: PartFrame[] = [];
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    // Inside a reply, work belongs to the reply's own flow and work log.
    const transcript = value.frame === "transcript" && !(reply && value.work),
      previous = frames.at(-1);
    if (!transcript && previous && !previous.transcript) {
      previous.parts.push(part);
    } else frames.push({ id: part.id, parts: [part], transcript });
  }
  return frames;
}
/** One presentation contract for transcript frames and prompt navigation. */
export function messageFrames(
  message: FramedMessage,
  presentation: (part: Part) => PartPresentation,
): {
  frames: PartFrame[];
  userBubble: boolean;
  prompt: boolean;
  copyable: boolean;
} {
  let copyable = false;
  const frames = partFrames(message.parts, (part) => {
    const value = presentation(part);
    copyable ||= value.copyable ?? !!value.text;
    return value;
  }, message.role === "assistant");
  const role = messageLayoutRole(message);
  const userBubble = role === "user" &&
    frames.some((frame) => !frame.transcript);
  return {
    copyable,
    userBubble,
    frames: frames.length || message.role === "user" ? frames : [{
      id: message.id,
      parts: [],
      transcript: false,
    }],
    prompt: role === "user" && userBubble,
  };
}
/** Layout groups follow feature contributions, never a central part-kind list. */
export function partGroups(
  parts: Part[],
  presentation: (part: Part) => PartPresentation,
): PartGroup[] {
  const groups: PartGroup[] = [];
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    const work = !!value.work, previous = groups.at(-1);
    if (work && previous?.work) {
      previous.parts.push(part);
      if (value.required) previous.required = true;
    } else {groups.push({
        id: part.id,
        parts: [part],
        work,
        ...(value.required ? { required: true } : {}),
      });}
  }
  return groups;
}
export const elapsed = (start: number, end: number) => duration(end - start);
export const workingTime = (timing: TurnTiming | undefined) =>
  timing?.state === "known" || timing?.state === "active"
    ? `Worked for ${duration(timing.workingMs)}`
    : timing?.state === "unknown"
    ? "Time unknown"
    : undefined;
export const timingExplanation = (timing: TurnTiming | undefined) =>
  timing?.state === "unknown"
    ? timing.explanation ?? "The recorded timing evidence is incomplete."
    : undefined;
