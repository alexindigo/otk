// SPDX-License-Identifier: LGPL-3.0-only
import type { TurnTimingEvidence } from "@otk/harness";
import type { Info, RawPart } from "./types.ts";
import { assistantSettled } from "./map.ts";

export interface TimingPart {
  type: string;
  name?: string;
  start?: number;
  end?: number;
}
export function partClocks(parts: readonly RawPart[]): TimingPart[] {
  return parts.filter((p) =>
    ["text", "reasoning", "tool", "retry"].includes(p.type)
  )
    .map((p) => ({
      type: p.type,
      name: p.tool,
      ...(p.type === "tool" ? p.state?.time : p.time),
    }));
}
/** V1 settles a call after its tools; output/dispatch clocks separate those phases. */
export function timingEvidence(
  info: Pick<Info, "time" | "error" | "finish">,
  parts: readonly TimingPart[],
  settled = assistantSettled(info),
): TurnTimingEvidence {
  const start = info.time.created,
    end = info.time.completed,
    terminal = settled;
  const busy: TurnTimingEvidence["busy"] = [],
    waits: TurnTimingEvidence["waits"] = [];
  const tools = parts.filter((p) => p.type === "tool");
  const output = parts.filter((p) =>
    ["text", "reasoning"].includes(p.type) && p.end != null
  ).map((
    p,
  ) => p.end!);
  const dispatch = tools.filter((p) => p.start != null).map((p) => p.start!);
  // Every dispatch is model output too; an earlier text/dispatch cannot end
  // the model interval while later arguments are still being produced.
  const edges = [...output, ...dispatch];
  const modelEnd = edges.length
    ? edges.reduce((latest, edge) => Math.max(latest, edge), 0)
    : end;
  if (modelEnd !== undefined) busy.push({ start, end: modelEnd });
  // V1 persists retry observations but not the resumed provider-request clock.
  const retry = parts.some((p) => p.type === "retry");
  let incomplete = retry;
  for (const tool of tools) {
    if (tool.start == null || tool.end == null) {
      incomplete = true;
      continue;
    }
    const interval = { start: tool.start, end: tool.end };
    if (tool.name === "question") waits.push(interval);
    else busy.push(interval);
  }
  return {
    start,
    ...(end === undefined ? {} : { end }),
    terminal,
    source: "native-call",
    busy,
    waits,
    ...(retry || terminal && (end === undefined || incomplete)
      ? {
        unknown: terminal && end === undefined
          ? "missing-end" as const
          : "incomplete-evidence" as const,
      }
      : {}),
  };
}
