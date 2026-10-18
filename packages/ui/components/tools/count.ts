// SPDX-License-Identifier: LGPL-3.0-only
export function countLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
