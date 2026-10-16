// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";

import type { PartPresentation, WorkTime } from "../registries/renderers.ts";
export type { WorkTime } from "../registries/renderers.ts";
export interface PartGroup {
  id: string;
  parts: Part[];
  work: boolean;
  time: WorkTime;
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
    const time = value.work, previous = groups.at(-1);
    if (time && previous?.work) {
      previous.parts.push(part);
      if (time.start !== undefined) {
        previous.time.start = Math.min(
          previous.time.start ?? time.start,
          time.start,
        );
      }
      previous.time.end =
        time.end !== undefined && previous.time.end !== undefined
          ? Math.max(previous.time.end, time.end)
          : undefined;
    } else {groups.push({
        id: part.id,
        parts: [part],
        work: !!time,
        time: { ...time },
      });}
  }
  return groups;
}
export const elapsed = (start: number, end: number) =>
  `${Math.max(0, (end - start) / 1000).toFixed(1)}s`;
