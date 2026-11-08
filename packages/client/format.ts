// SPDX-License-Identifier: LGPL-3.0-only
import { countLabel } from "./count.ts";
const exact = new Intl.NumberFormat("en-US");
/** Exact audit counts; compact labels remain the usage formatter's concern. */
export const exactCount = (value: number): string => exact.format(value);
export const duration = (ms: number): string =>
  `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
/** Human status durations share units; clocks and ETA rounding belong to callers. */
export function humanDuration(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed >= 86400_000) {
    return countLabel(Math.floor(elapsed / 86400_000), "day");
  }
  if (elapsed >= 3600_000) {
    return countLabel(Math.floor(elapsed / 3600_000), "hour");
  }
  if (elapsed >= 60_000) return `${Math.floor(elapsed / 60_000)} min`;
  return `${Math.floor(elapsed / 1000)} s`;
}
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
