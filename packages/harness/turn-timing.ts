// SPDX-License-Identifier: LGPL-3.0-only
import type { TurnTiming } from "@otk/protocol";

export interface BusyInterval {
  start: number;
  end: number;
}
/** Adapters own native clocks and provenance. No observation/next-prompt clocks. */
export interface TurnTimingEvidence {
  start: number;
  end?: number;
  terminal: boolean;
  source: string;
  busy: BusyInterval[];
  waits: BusyInterval[];
  unknown?: "migration" | "missing-end" | "incomplete-evidence";
  explanation?: string;
}
const clock = (value: number) => Number.isSafeInteger(value) && value >= 0;
function union(intervals: BusyInterval[]): BusyInterval[] {
  const result: BusyInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else result.push({ ...interval });
  }
  return result;
}
/** One neutral owner for busy-union minus waits, shared by both native adapters. */
export class TurnTimingAccumulator {
  #values: TurnTimingEvidence[] = [];
  add(value: TurnTimingEvidence): void {
    if (
      !value.source || !clock(value.start) ||
      value.end !== undefined &&
        (!clock(value.end) || value.end < value.start) ||
      [...value.busy, ...value.waits].some((i) =>
        !clock(i.start) || !clock(i.end) || i.end < i.start
      )
    ) {
      throw new TypeError("Invalid turn timing evidence");
    }
    this.#values.push(value);
  }
  result(): TurnTiming | undefined {
    if (!this.#values.length) return;
    const start = this.#values.reduce(
      (min, v) => Math.min(min, v.start),
      Infinity,
    );
    const terminal = this.#values.every((v) => v.terminal);
    const unknown = this.#values.find((v) => v.unknown === "migration") ??
      this.#values.find((v) => v.unknown);
    const reason = unknown?.unknown;
    const complete = this.#values.every((v) => v.end !== undefined);
    const end = complete
      ? this.#values.reduce((max, v) => Math.max(max, v.end!), 0)
      : undefined;
    if (reason || this.#values.some((v) => v.terminal && v.end === undefined)) {
      return {
        state: "unknown",
        start,
        ...(end === undefined ? {} : { end }),
        terminal,
        reason: reason ?? "missing-end",
        ...(unknown?.explanation ? { explanation: unknown.explanation } : {}),
      };
    }
    const busy = union(this.#values.flatMap((v) => v.busy));
    const waits = union(this.#values.flatMap((v) => v.waits));
    let workingMs = 0, cursor = 0;
    for (const interval of busy) {
      workingMs += interval.end - interval.start;
      while (cursor < waits.length && waits[cursor].end <= interval.start) {
        cursor++;
      }
      for (
        let i = cursor;
        i < waits.length && waits[i].start < interval.end;
        i++
      ) {
        workingMs -= Math.max(
          0,
          Math.min(interval.end, waits[i].end) -
            Math.max(interval.start, waits[i].start),
        );
      }
    }
    return terminal
      ? { state: "known", start, end: end!, workingMs }
      : { state: "active", start, workingMs };
  }
}
