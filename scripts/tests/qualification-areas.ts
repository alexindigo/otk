// SPDX-License-Identifier: LGPL-3.0-only
import { areas } from "./selection.ts";

// Scale is an explicit qualification tier, not a standard per-commit area.
export const qualificationAreas: ReadonlySet<string> = new Set([
  ...areas,
  "scale",
]);
export function qualificationTags(tags: string[]): string[] {
  return tags.filter((tag) => qualificationAreas.has(tag.replace(/^@/, "")));
}
