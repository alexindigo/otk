// SPDX-License-Identifier: LGPL-3.0-only
import type { Message, Part } from "@otk/protocol";
import { duration } from "@otk/client";
export { createMessageLayout } from "./message-layout.ts";

import type { PartPresentation } from "../registries/renderers.ts";
export type { WorkTime } from "../registries/renderers.ts";
export interface PartGroup {
  id: string;
  parts: Part[];
  work: boolean;
}
export interface PartFrame {
  id: string;
  parts: Part[];
  transcript: boolean;
}
/** Feature-owned framing is separate from work grouping; mixed messages keep
 * ordinary adjacent content together without enclosing transcript markers. */
export function partFrames(
  parts: Part[],
  presentation: (part: Part) => PartPresentation,
): PartFrame[] {
  const frames: PartFrame[] = [];
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    const transcript = value.frame === "transcript", previous = frames.at(-1);
    if (!transcript && previous && !previous.transcript) {
      previous.parts.push(part);
    } else frames.push({ id: part.id, parts: [part], transcript });
  }
  return frames;
}
/** One presentation contract for transcript frames and prompt navigation. */
export function messageFrames(
  message: Pick<Message, "id" | "role" | "parts">,
  presentation: (part: Part) => PartPresentation,
): { frames: PartFrame[]; prompt: boolean; copyable: boolean } {
  let copyable = false;
  const frames = partFrames(message.parts, (part) => {
    const value = presentation(part);
    copyable ||= value.copyable ?? !!value.text;
    return value;
  });
  return {
    copyable,
    frames: frames.length || message.role === "user" ? frames : [{
      id: message.id,
      parts: [],
      transcript: false,
    }],
    prompt: message.role === "user" &&
      frames.some((frame) => !frame.transcript),
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
    } else {groups.push({
        id: part.id,
        parts: [part],
        work,
      });}
  }
  return groups;
}
export const elapsed = (start: number, end: number) => duration(end - start);
