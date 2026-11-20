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

export interface MessagePresentation {
  streaming: boolean;
  progress: boolean;
  time?: { timing?: TurnTiming; fallback?: string; outcome?: OutcomeTime };
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
        fallback: streaming ? "streaming" : "Time unknown",
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
