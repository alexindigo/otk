// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Activity,
  AssistantMessage,
  Message,
  Part,
  TurnTiming,
} from "@otk/protocol";
import { TurnTimingAccumulator } from "@otk/protocol";
import { isAssistantTerminal } from "@otk/protocol";
import {
  foldRecords,
  hasActiveRecord,
  type RecordKindFold,
  type TranscriptProjectionState,
  workLogBookkeeping,
} from "@otk/client";
export { hasActiveRecord } from "@otk/client";
export { createMessageLayout } from "./message-layout.ts";

import type { PartPresentation } from "../registries/renderers.ts";
export type { WorkTime } from "../registries/renderers.ts";
export interface ReplyStart {
  messageID: string;
  turnID?: string;
  timing?: TurnTiming;
  outcomeTime?: import("@otk/protocol").OutcomeTime;
  agent: string;
  model?: AssistantMessage["model"];
  time: AssistantMessage["time"];
  continuation: boolean;
}
export interface PartGroup {
  id: string;
  parts: Part[];
  work: boolean;
  required?: boolean;
  recordCounts?: RecordKindFold[];
  workingMs?: number;
  replyStart?: ReplyStart;
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
  const work: Part[] = [];
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    if (reply && value.work) {
      work.push(part);
      continue;
    }
    const transcript = value.frame === "transcript",
      previous = frames.at(-1);
    if (!transcript && previous && !previous.transcript) {
      previous.parts.push(part);
    } else frames.push({ id: part.id, parts: [part], transcript });
  }
  if (work.length) {
    const last = frames.at(-1);
    if (last && !last.transcript) last.parts.push(...work);
    else frames.push({ id: work[0].id, parts: work, transcript: false });
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
  timingParts: readonly Part[] = parts,
  replyStart?: (part: Part) => ReplyStart | undefined,
): PartGroup[] {
  const groups: PartGroup[] = [];
  let work: PartGroup | undefined;
  const markers: Activity[] = [];
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    if (value.work) {
      const bookkeeping = workLogBookkeeping(part);
      if (bookkeeping) {
        if (bookkeeping === "step" && value.activity) {
          markers.push(value.activity);
        }
        continue;
      }
      work ??= { id: part.id, parts: [], work: true };
      work.parts.push(part);
      if (value.required) work.required = true;
    } else {groups.push({
        id: part.id,
        parts: [part],
        work: false,
        ...(value.prose ? { replyStart: replyStart?.(part) } : {}),
        ...(value.required ? { required: true } : {}),
      });}
  }
  if (work) {
    if (markers.length) {
      work.recordCounts = foldRecords(markers, (activity) =>
        activity, () => false).folds;
    }
    const workingMs = segmentWorkingTime(work.parts, presentation, timingParts);
    if (workingMs !== undefined) work.workingMs = workingMs;
    groups.push(work);
  }
  return groups;
}
export const segmentWorkingTime = (
  parts: readonly Part[],
  presentation: (part: Part) => PartPresentation,
  timingParts: readonly Part[] = parts,
) => {
  const own = parts.flatMap((part) => {
    const timing = presentation(part).timing;
    return timing ? [timing] : [];
  });
  if (!own.length) return;
  return TurnTimingAccumulator.segment([
    ...own.filter((timing) => !timing.waitsForUser),
    ...timingParts.flatMap((part) => {
      const timing = presentation(part).timing;
      return timing?.waitsForUser ? [timing] : [];
    }),
  ]);
};
export { timingExplanation, workingTimeValue } from "@otk/client";
/** One progress owner for the active turn, borrowing canonical queue membership. */
export function activeProgressRecord(
  { messageIDs, messagesByID, queuedIDs }: Pick<
    TranscriptProjectionState,
    "messageIDs" | "messagesByID" | "queuedIDs"
  >,
): string | undefined {
  let record: string | undefined;
  for (let i = messageIDs.length - 1; i >= 0; i--) {
    const message = messagesByID[messageIDs[i]];
    if (!message) break;
    if (message.role === "user") {
      if (queuedIDs.has(message.id)) continue;
      break;
    }
    if (message.role === "assistant" && !isAssistantTerminal(message)) {
      return undefined;
    }
    if (!record && hasActiveRecord(message)) record = message.id;
  }
  return record;
}
