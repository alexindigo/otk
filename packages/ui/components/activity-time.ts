// SPDX-License-Identifier: LGPL-3.0-only
/** Indistinguishable formatted endpoints describe one clock, not a range. */
export function activityTimeRange(
  time: { first: number; last?: number },
  format: (value: number) => string,
): string {
  const first = format(time.first);
  const last = time.last === undefined ? first : format(time.last);
  return first === last ? first : `${first} - ${last}`;
}
