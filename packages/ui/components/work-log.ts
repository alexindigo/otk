// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";

import type { PartPresentation } from "../registries/renderers.ts";
export type { WorkTime } from "../registries/renderers.ts";
export interface PartGroup {
  id: string;
  parts: Part[];
  work: boolean;
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
export const elapsed = (start: number, end: number) =>
  `${Math.max(0, (end - start) / 1000).toFixed(1)}s`;
