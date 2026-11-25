// SPDX-License-Identifier: LGPL-3.0-only
const exact = new Intl.NumberFormat("en-US");
/** Exact audit counts; compact labels remain the usage formatter's concern. */
export const exactCount = (value: number): string => exact.format(value);
export type TimeUnit = "d" | "h" | "m" | "s";
export interface TimePart {
  readonly value: string;
  readonly unit: TimeUnit;
}
export interface TimeText {
  readonly parts: readonly TimePart[];
  readonly word?: "now";
  readonly text: string;
  readonly spoken: string;
  readonly iso: string;
}

export const META_SEPARATOR = " · ";
export function metaParts<T>(
  items: readonly (T | string | undefined | false)[],
): (T | string)[] {
  return items.filter((item): item is T | string =>
    item !== undefined && item !== false && item !== ""
  );
}
/** One plain-text metadata flow, shared by ChromeMeta and tool presentations. */
export const metaList = (
  items: readonly (TimeText | string | undefined | false)[],
): string =>
  metaParts(items).map((item) => typeof item === "string" ? item : item.text)
    .join(META_SEPARATOR);

const unitNames = { d: "day", h: "hour", m: "minute", s: "second" } as const;
const units = Object.fromEntries(
  Object.entries(unitNames).map(([key, unit]) => [
    key,
    new Intl.NumberFormat("en-US", {
      style: "unit",
      unit,
      unitDisplay: "long",
    }),
  ]),
) as Record<TimeUnit, Intl.NumberFormat>;
const list = new Intl.ListFormat("en-US", { style: "long", type: "unit" });

type AgeReference = "now" | "inactive";
function build(
  parts: readonly TimePart[],
  age?: { at: number; reference: AgeReference },
): TimeText {
  if (age && !parts.length) {
    return {
      parts,
      word: "now",
      text: "now",
      spoken: "just now",
      iso: new Date(age.at).toISOString(),
    };
  }
  const text = parts.map(({ value, unit }) => `${value}${unit}`).join(" ");
  const spoken = list.format(
    parts.map(({ value, unit }) => units[unit].format(Number(value))),
  );
  if (age) {
    const suffix = age.reference === "now"
      ? " ago"
      : " before it became inactive";
    return {
      parts,
      text,
      spoken: spoken + suffix,
      iso: new Date(age.at).toISOString(),
    };
  }
  const date = parts[0]?.unit === "d" ? `${parts[0].value}D` : "";
  const time = parts.slice(date ? 1 : 0).map(({ value, unit }) =>
    `${value}${unit.toUpperCase()}`
  ).join("");
  return { parts, text, spoken, iso: `P${date}${time ? `T${time}` : ""}` };
}

/** One elapsed-time vocabulary for work, progress, idle and ETA; no timers. */
export function elapsed(ms: number): TimeText {
  let seconds = Math.round(Math.max(0, ms) / 100) / 10;
  const parts: TimePart[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]] as const) {
    const count = Math.floor(seconds / size);
    if (count) parts.push({ value: String(count), unit });
    seconds = Math.round((seconds % size) * 10) / 10;
  }
  if (seconds || !parts.length) {
    parts.push({ value: String(seconds), unit: "s" });
  }
  return build(parts);
}

/** Clocks are supplied by callers; this formatter owns no timer. */
export function age(
  at: number,
  now: number,
  reference: AgeReference = "now",
): TimeText {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  const hours = Math.floor(minutes / 60);
  const parts: TimePart[] = [];
  if (hours >= 24) {
    parts.push({ value: String(Math.floor(hours / 24)), unit: "d" });
  }
  if (hours % 24) parts.push({ value: String(hours % 24), unit: "h" });
  if (minutes >= 1 && minutes < 60) {
    parts.push({ value: String(minutes), unit: "m" });
  }
  return build(parts, { at, reference });
}

export function remaining(ms: number, step: "second" | "minute"): TimeText {
  const size = step === "second" ? 1000 : 60_000;
  return elapsed(Math.max(1, Math.ceil(ms / size)) * size);
}

export interface RequestAgeText {
  readonly lead: "Session idle";
  readonly time: TimeText;
}

/** Missing/invalid session activity has no age; observation time is not ask age. */
export function requestIdle(time: number | undefined, now: number):
  | (RequestAgeText & { resume?: string })
  | { lead?: never; time?: never; resume?: never } {
  if (
    time === undefined || !Number.isFinite(time) || time <= 0 ||
    !Number.isFinite(now)
  ) return {};
  const ms = Math.max(0, now - time);
  const result = elapsed(ms);
  return {
    lead: "Session idle",
    time: result,
    ...(ms > 86400_000
      ? { resume: `Resumes work paused ${result.text} ago` }
      : {}),
  };
}
