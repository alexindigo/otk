// SPDX-License-Identifier: LGPL-3.0-only
/** A terminal outcome's native instant, independent of measured working time. */
export type OutcomeTime =
  | {
    state: "known";
    at: number;
    source: "completed" | "error" | "part" | "event";
  }
  | { state: "unknown"; reason: string };

/** Producers normalize native clocks once. Never substitute observation time. */
export function outcomeTime(clocks: {
  completed?: number;
  error?: number;
  parts?: readonly (number | undefined)[];
  event?: number;
}): OutcomeTime {
  const valid = (at: number | undefined): at is number =>
    at !== undefined && Number.isSafeInteger(at) && at >= 0;
  for (const source of ["completed", "error"] as const) {
    const at = clocks[source];
    if (valid(at)) return { state: "known", at, source };
  }
  const parts = clocks.parts?.filter(valid);
  if (parts?.length) {
    return {
      state: "known",
      at: parts.reduce((a, b) => Math.max(a, b)),
      source: "part",
    };
  }
  if (valid(clocks.event)) {
    return { state: "known", at: clocks.event, source: "event" };
  }
  return {
    state: "unknown",
    reason: "No native completion, error or part timestamp was recorded.",
  };
}
