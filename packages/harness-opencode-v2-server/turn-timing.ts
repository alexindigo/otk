// SPDX-License-Identifier: LGPL-3.0-only
import type { TurnTimingEvidence } from "@otk/harness";
import { assistantSettled, millis, record } from "./map.ts";

/** Scalar clocks only. Native streamed is the provider-body edge, not settlement. */
export function timingEvidence(
  raw: unknown,
  migrated = false,
): TurnTimingEvidence {
  const message = record(raw), time = record(message.time);
  const start = millis(time.created),
    completed = time.completed == null ? undefined : millis(time.completed);
  const streamed = time.streamed == null ? undefined : millis(time.streamed);
  const legacy = migrated && streamed === undefined;
  const terminal = legacy ||
    assistantSettled({ time, error: message.error, finish: message.finish });
  const busy: TurnTimingEvidence["busy"] = [],
    waits: TurnTimingEvidence["waits"] = [];
  let incomplete = false;
  if (streamed !== undefined) busy.push({ start, end: streamed });
  for (const item of Array.isArray(message.content) ? message.content : []) {
    const part = record(item), clock = record(part.time);
    if (part.type !== "tool") continue;
    const began = clock.ran ?? clock.created, ended = clock.completed;
    if (began == null || ended == null) {
      incomplete = true;
      continue;
    }
    const interval = { start: millis(began), end: millis(ended) };
    // The question's recorded lifetime is a user wait, not tool computation.
    if (part.name === "question") waits.push(interval);
    else busy.push(interval);
  }
  const lost = legacy;
  return {
    start,
    ...(completed === undefined || lost ? {} : { end: completed }),
    terminal,
    source: legacy ? "legacy-migration" : "native-step",
    busy,
    waits,
    ...(lost
      ? {
        unknown: completed === undefined
          ? "missing-end" as const
          : "migration" as const,
        explanation: completed === undefined
          ? "No end time was recorded for this migrated response."
          : "The real end time was lost when opencode migrated this session.",
      }
      : terminal && (streamed === undefined || incomplete)
      ? {
        unknown: completed === undefined
          ? "missing-end" as const
          : "incomplete-evidence" as const,
      }
      : {}),
  };
}
