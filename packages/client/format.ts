// SPDX-License-Identifier: LGPL-3.0-only
const exact = new Intl.NumberFormat("en-US");
/** Exact audit counts; compact labels remain the usage formatter's concern. */
export const exactCount = (value: number): string => exact.format(value);
/** One plain-text metadata flow, shared by ChromeMeta and tool presentations. */
export const metaList = (
  items: readonly (string | undefined | false)[],
): string =>
  items.filter((item) => item !== undefined && item !== false && item !== "")
    .join(" · ");
/** One elapsed-time vocabulary for work, progress, idle and ETA; no timers. */
export function duration(ms: number): string {
  let seconds = Math.round(Math.max(0, ms) / 100) / 10;
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]] as const) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${unit}`);
    seconds = Math.round((seconds % size) * 10) / 10;
  }
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(" ");
}
/** Compatibility name; all consumers share duration's format. */
export const humanDuration = duration;
/** Missing/invalid session activity has no age; observation time is not ask age. */
export function requestIdle(time: number | undefined, now: number): {
  label?: string;
  resume?: string;
} {
  if (
    time === undefined || !Number.isFinite(time) || time <= 0 ||
    !Number.isFinite(now)
  ) return {};
  const elapsed = Math.max(0, now - time);
  const age = humanDuration(elapsed);
  return {
    label: `Session idle ${age}`,
    ...(elapsed > 86400_000
      ? { resume: `Resumes work paused ${age} ago` }
      : {}),
  };
}
/** Clocks are supplied by callers; this formatter owns no timer. */
export function relativeTime(time: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24), rest = hours % 24;
  return `${days}d${rest ? ` ${rest}h` : ""}`;
}
