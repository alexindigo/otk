// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Activity,
  AssistantMessage,
  Message,
  Part,
  PublicFailure,
  TurnTiming,
} from "@otk/protocol";
import { TurnTimingAccumulator } from "@otk/protocol";
import { isAssistantTerminal } from "@otk/protocol";
import {
  countLabel,
  elapsed,
  foldRecords,
  hasActiveRecord,
  type RecordKindFold,
  type TranscriptProjectionState,
  type TranscriptReply,
  UNKNOWN_TIME,
  workLogBookkeeping,
} from "@otk/client";
export { hasActiveRecord } from "@otk/client";
export { createMessageLayout } from "./message-layout.ts";

import type {
  PartPresentation,
  WorkRunFacts,
  WorkTime,
} from "../registries/renderers.ts";
export interface WorkRun {
  key: string;
  lane: "thinking" | "action" | "delegation";
  label: string;
  partIDs: string[];
  start?: number;
  end?: number;
  thinkingMs?: number;
  thinkingIDs?: string[];
  live: boolean;
  failed: boolean;
  failure?: PublicFailure;
  failureReason?: string;
  child?: string;
  agent?: string;
}
export interface WorkSegment {
  run: string;
  lane: WorkRun["lane"];
  failed: boolean;
  live: boolean;
  weightMs: number;
  title: string;
  agent?: string;
}
export interface WorkRuns {
  runs: WorkRun[];
  segments: WorkSegment[];
  actions: number;
  failed: WorkRun[];
  live?: WorkRun;
  bookkeeping: Part[];
  trailingThoughts: string[];
  summary: string;
  runOf(partID: string): string | undefined;
}
export const WORK_STRIP_MAX_SEGMENTS = 60;

interface RunInput {
  parts: readonly Part[];
  presentation: (part: Part) => PartPresentation;
  terminal: boolean;
}
interface ModelInput {
  reply: (key: string) => TranscriptReply | undefined;
  replyKeys: () => readonly string[];
  presentation: (part: Part) => PartPresentation;
  /** Change when preferences that affect the part presentation change. */
  presentationRevision?: () => unknown;
  now: () => number;
}

export function workRuns(
  { now, ...input }: RunInput & { now: number },
): WorkRuns {
  return deriveWorkRuns(input, () => now);
}

/** Share one projection per reply revision; only the live segment reads the clock. */
export function createWorkModel(
  input: ModelInput,
): { runs(key: string): WorkRuns | undefined; turns(): string[] } {
  const cache = new WeakMap<
    TranscriptReply,
    { revision: number; presentation: unknown; value: WorkRuns }
  >();
  const runs = (key: string) => {
    const reply = input.reply(key);
    if (reply?.message.role !== "assistant") return;
    const presentation = input.presentationRevision?.();
    const cached = cache.get(reply);
    if (
      cached?.revision === reply.revision &&
      Object.is(cached.presentation, presentation)
    ) return cached.value;
    const value = deriveWorkRuns({
      parts: reply.message.parts,
      presentation: input.presentation,
      terminal: isAssistantTerminal(reply.message),
    }, input.now);
    cache.set(reply, { revision: reply.revision, presentation, value });
    return value;
  };
  return {
    runs,
    turns: () =>
      input.replyKeys().filter((key) => !!runs(key)?.segments.length),
  };
}

interface WorkRecord {
  id: string;
  time: WorkTime;
  facts: WorkRunFacts;
  failed: boolean;
  failure?: PublicFailure;
}

function deriveWorkRuns(
  { parts, presentation, terminal }: RunInput,
  now: () => number,
): WorkRuns {
  const bookkeeping: Part[] = [], records: WorkRecord[] = [];
  const latest = new Map<string, WorkRecord>();
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    if (
      workLogBookkeeping(part) ||
      (value.activity?.fold &&
        foldRecords([part], () => value.activity, () => false).visible
            .length === 0)
    ) {
      bookkeeping.push(part);
      continue;
    }
    if (!value.work) continue;
    const facts = value.run ?? { label: value.activity?.title ?? part.kind };
    const record = {
      id: part.id,
      time: value.work,
      facts,
      failure: value.failure,
      failed:
        !!(value.failure || value.required || value.activity?.tone === "error"),
    };
    records.push(record);
    if (facts.merge?.keep === "latest") latest.set(facts.merge.key, record);
  }

  const runs: WorkRun[] = [], strip: WorkRun[] = [], thinking: WorkRun[] = [];
  const runByPart = new Map<string, string>();
  let previousMerge: string | undefined, actions = 0, live: WorkRun | undefined;
  for (const { id, time: { start, end }, facts, failed, failure } of records) {
    const { lane = "action", label, merge, child, agent, failureReason } =
      facts;
    if (merge?.keep === "latest" && latest.get(merge.key)?.id !== id) continue;
    const active = !terminal && start !== undefined && end === undefined;
    if (lane === "thinking") {
      const run: WorkRun = {
        key: id,
        lane,
        label,
        partIDs: [id],
        start,
        end,
        live: active,
        failed,
        failure,
        failureReason,
        child,
        agent,
      };
      strip.push(run);
      thinking.push(run);
      previousMerge = undefined;
      continue;
    }
    actions++;
    let run = runs.at(-1);
    if (
      run && merge && merge.key === previousMerge && merge.keep !== "latest"
    ) {
      run.partIDs.push(id);
      run.label = `${merge.verb} ${
        countLabel(run.partIDs.length, merge.noun, merge.plural)
      }`;
      run.end = run.end === undefined || end === undefined
        ? undefined
        : Math.max(run.end, end);
      run.failed ||= failed;
      run.failure ??= failure;
      run.failureReason ??= failureReason;
      run.live ||= active;
      if (lane === "delegation") run.lane = lane;
      run.child ??= child;
      run.agent ??= agent;
    } else {
      run = {
        key: id,
        lane,
        label,
        partIDs: [id],
        start,
        end,
        live: active,
        failed,
        failure,
        failureReason,
        child,
        agent,
      };
      if (thinking.length) {
        run.thinkingIDs = thinking.map((thought) => thought.key);
        run.thinkingMs = thinking.reduce(
          (sum, thought) => sum + (workDuration(thought) ?? 0),
          0,
        );
        for (const thought of thinking) runByPart.set(thought.key, run.key);
        thinking.length = 0;
      }
      runs.push(run);
      strip.push(run);
    }
    if (run.live) live = run;
    runByPart.set(id, run.key);
    previousMerge = merge?.key;
  }

  const segments = strip.map((run) =>
    workSegment(
      run,
      runByPart.get(run.key) ?? runs.at(-1)?.key ?? run.key,
      now,
    )
  );
  const failed = runs.filter((run) => run.failed);
  const count = countLabel(actions, "action") +
    (failed.length ? `, ${failed.length} failed` : "");
  const labels = runs.map((run) => run.label + (run.failed ? " (failed)" : ""));
  return {
    runs,
    segments: compactSegments(segments),
    actions,
    failed,
    live,
    bookkeeping,
    trailingThoughts: thinking.map((thought) => thought.key),
    summary: `Work log: ${count}${
      labels.length ? `. ${labels.join("; ")}` : ""
    }`,
    runOf: (id) => runByPart.get(id),
  };
}

function workDuration({ start, end }: WorkTime): number | undefined {
  if (start !== undefined && end !== undefined) return Math.max(0, end - start);
}

function workSegment(
  run: WorkRun,
  target: string,
  now: () => number,
): WorkSegment {
  const { lane, failed, live, label, start, end, agent } = run;
  const value = { run: target, lane, failed, live, agent };
  const title = (weight: number | undefined) =>
    `${label}, ${weight === undefined ? UNKNOWN_TIME : elapsed(weight).text}`;
  if (live) {
    const duration = () => workDuration({ start, end: now() });
    return {
      ...value,
      get weightMs() {
        return duration() ?? 0;
      },
      get title() {
        return title(duration());
      },
    };
  }
  const duration = workDuration({ start, end });
  return { ...value, weightMs: duration ?? 0, title: title(duration) };
}

function compactSegments(segments: WorkSegment[]): WorkSegment[] {
  const eligible = (a: WorkSegment, b: WorkSegment) =>
    !a.failed && !a.live && !b.failed && !b.live;
  const join = (index: number) => {
    const [a, b] = segments.slice(index, index + 2);
    // A mixed pair points to its action, not to a separate thinking row.
    const target = a.lane === "thinking" && b.lane === "action" ? b : a;
    segments.splice(index, 2, { ...target, weightMs: a.weightMs + b.weightMs });
  };
  for (
    let index = 0;
    segments.length > WORK_STRIP_MAX_SEGMENTS && index + 1 < segments.length;
  ) {
    const [a, b] = [segments[index], segments[index + 1]];
    if (eligible(a, b) && a.lane === b.lane && a.agent === b.agent) join(index);
    else index++;
  }
  while (segments.length > WORK_STRIP_MAX_SEGMENTS) {
    let shortest = Infinity, pair: number | undefined;
    for (let index = 0; index + 1 < segments.length; index++) {
      const [a, b] = [segments[index], segments[index + 1]];
      if (
        !eligible(a, b) || a.lane === "delegation" || b.lane === "delegation"
      ) continue;
      const weight = a.weightMs + b.weightMs;
      if (weight < shortest) {
        shortest = weight;
        pair = index;
      }
    }
    // A strip consisting only of protected or otherwise non-mergeable pairs must keep those facts.
    if (pair === undefined) break;
    join(pair);
  }
  return segments;
}
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
  for (const part of parts) {
    const value = presentation(part);
    if (value.hidden) continue;
    if (reply && value.work) continue;
    const transcript = value.frame === "transcript",
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
