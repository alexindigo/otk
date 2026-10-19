// SPDX-License-Identifier: LGPL-3.0-only
/** Title-case names only. Fallback copy is already written for display. */
export function selectionLabel(
  value: string | undefined,
  fallback = "",
): string {
  return value === undefined
    ? fallback
    : value.replace(/(^|[\s_-])\p{L}/gu, (letter) => letter.toUpperCase());
}
