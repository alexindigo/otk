// SPDX-License-Identifier: LGPL-3.0-only
import { countLabel } from "./count.ts";
const exact = new Intl.NumberFormat("en-US");
/** Exact audit counts; compact labels remain the usage formatter's concern. */
export const exactCount = (value: number): string => exact.format(value);
export const duration = (ms: number): string =>
  `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
/** Session activity is authoritative; request observation time is not ask age. */
export function requestIdle(time: number | undefined, now: number): {
  label: string;
  resume?: string;
} {
  if (time === undefined) return { label: "Session activity unavailable" };
  const elapsed = Math.max(0, now - time);
  const unit = elapsed >= 86400_000
    ? "day"
    : elapsed >= 3600_000
    ? "hour"
    : "minute";
  const count = Math.floor(
    elapsed /
      (unit === "day" ? 86400_000 : unit === "hour" ? 3600_000 : 60_000),
  );
  const age = countLabel(count, unit);
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
