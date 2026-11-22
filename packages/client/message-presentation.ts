// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue, isAssistantTerminal } from "@otk/protocol";
import type {
  Derived,
  Message,
  OutcomeTime,
  TurnTiming,
  UsageSummary,
} from "@otk/protocol";
import { countLabel } from "./count.ts";
import { usageCost, usageTokens } from "./usage.ts";
import { reportedTokens } from "./session-summary.ts";
import { duration } from "./format.ts";

export const UNKNOWN_TIME = "Time unknown";
export type TimeValue =
  | { state: "known"; text: string }
  | { state: "counting"; text?: string }
  | { state: "unknown"; explanation: string };
export function unknownTime(explanation?: string): TimeValue {
  return {
    state: "unknown",
    explanation: explanation ?? "The recorded timing evidence is incomplete.",
  };
}
export const timingExplanation = (
  timing: TurnTiming | undefined,
): string | undefined =>
  timing?.state === "unknown"
    ? timing.explanation ??
      (timing.reason === "migration"
        ? "The timing was lost when opencode migrated this session."
        : "The recorded timing evidence is incomplete.")
    : undefined;

export function workingTime(
  timing: TurnTiming | number | undefined,
): string | undefined {
  return typeof timing === "number"
    ? `Worked for ${duration(timing)}`
    : timing?.state === "known" || timing?.state === "active"
    ? `Worked for ${duration(timing.workingMs)}`
    : timing?.state === "unknown"
    ? UNKNOWN_TIME
    : undefined;
}
export function workingTimeValue(
  timing: TurnTiming | number | undefined,
  pending = timing === undefined ||
    typeof timing !== "number" && timing.state === "active",
): TimeValue {
  if (pending) {
    const value = typeof timing === "number"
      ? timing
      : timing?.state === "known" || timing?.state === "active"
      ? timing.workingMs
      : undefined;
    return {
      state: "counting",
      ...(value !== undefined && duration(value) !== "0s"
        ? { text: workingTime(value) }
        : {}),
    };
  }
  return timing === undefined ||
      typeof timing !== "number" && timing.state === "unknown"
    ? unknownTime(
      typeof timing === "number" ? undefined : timingExplanation(timing),
    )
    : { state: "known", text: workingTime(timing)! };
}
/** Footer facts have one presentation owner; views do not classify evidence. */
export function messageTimeValue(time: MessagePresentation["time"]): TimeValue {
  if (time?.timing?.state === "unknown") {
    return unknownTime(
      time.timing.reason === "migration"
        ? timingExplanation(time.timing)
        : time.outcome?.state === "unknown"
        ? time.outcome.reason
        : timingExplanation(time.timing),
    );
  }
  return workingTimeValue(time?.timing, time?.counting || !time?.timing);
}

export interface MessagePresentation {
  streaming: boolean;
  progress: boolean;
  time?: {
    timing?: TurnTiming;
    fallback?: "counting...";
    counting?: boolean;
    outcome?: OutcomeTime;
  };
  usage?: { summary?: Derived<UsageSummary> };
  facts: string[];
}
/** Presentation authority is separate from native lifecycle evidence. Frozen
 * copies retain that evidence verbatim, but cannot imply continuing work. */
export function messagePresentation(
  message: Message,
  summary?: Derived<UsageSummary>,
  mode: "live" | "saved" = "live",
  activeRecord = false,
): MessagePresentation {
  const value = derivedValue(summary);
  const streaming = mode === "live" && message.role === "assistant" &&
    !isAssistantTerminal(message);
  if (mode === "live") {
    return {
      streaming,
      progress: streaming || activeRecord,
      time: {
        timing: value?.timing,
        fallback: !value?.timing ? "counting..." : undefined,
        ...(value?.timing && value.timing.state !== "unknown" &&
            (value.timing.state === "active" ||
              summary?.state === "known" && !summary.final)
          ? { counting: true }
          : {}),
        ...(!streaming && message.role !== "user" && message.outcomeTime
          ? { outcome: message.outcomeTime }
          : {}),
      },
      usage: { summary },
      facts: [],
    };
  }
  const facts: string[] = [];
  if (value) {
    facts.push(countLabel(value.calls, "model call"));
    const tokens = reportedTokens(value.tokens);
    if (tokens !== undefined) {
      facts.push(countLabel(tokens, "token", undefined, usageTokens(tokens)));
    }
    // Cost visibility remains a consumer preference, not captured source data.
  }
  return {
    streaming: false,
    progress: false,
    facts,
    ...(value?.timing?.state === "known" ||
        message.role !== "user" && message.outcomeTime
      ? {
        time: {
          timing: value?.timing,
          ...(message.role !== "user" && message.outcomeTime
            ? { outcome: message.outcomeTime }
            : {}),
        },
      }
      : {}),
  };
}

/** Cost is a known-only fact as well; callers pass the same show-cost preference
 * used by live usage without turning absent reports into placeholders. */
export function savedCost(
  summary: Derived<UsageSummary> | undefined,
): string | undefined {
  const value = derivedValue(summary);
  return value?.cost != null ? usageCost(value.cost) : undefined;
}
