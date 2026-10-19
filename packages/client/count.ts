// SPDX-License-Identifier: LGPL-3.0-only
/** Numeric value owns inflection even when display is compact or localised. */
export function countLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
  display: string = String(count),
): string {
  return `${display} ${count === 1 ? singular : plural}`;
}
