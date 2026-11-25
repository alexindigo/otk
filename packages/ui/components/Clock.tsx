// SPDX-License-Identifier: LGPL-3.0-only
import ChromeMeta from "./ChromeMeta.tsx";

export function clockText(at: number, precise = false): string {
  if (precise) {
    return new Date(at).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      timeZoneName: "short",
    });
  }
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
export function clockTitle(at: number): string {
  return new Date(at).toLocaleString(undefined, { timeZoneName: "short" });
}

/** One local-time presentation for transcript instants; the title keeps the date. */
export default function Clock(
  props: {
    at: number;
    class?: string;
    precise?: boolean;
    "data-record-time"?: string;
  },
) {
  const date = () => new Date(props.at);
  return (
    <ChromeMeta class={props.class}>
      <time
        datetime={date().toISOString()}
        title={clockTitle(props.at)}
        data-record-time={props["data-record-time"]}
      >
        {clockText(props.at, props.precise)}
      </time>
    </ChromeMeta>
  );
}
