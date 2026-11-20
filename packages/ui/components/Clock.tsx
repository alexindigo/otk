// SPDX-License-Identifier: LGPL-3.0-only
import ChromeMeta from "./ChromeMeta.tsx";

export function clockText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One local-time presentation for transcript instants; the title keeps the date. */
export default function Clock(props: { at: number; class?: string }) {
  const date = () => new Date(props.at);
  return (
    <ChromeMeta class={props.class}>
      <time
        datetime={date().toISOString()}
        title={date().toLocaleString(undefined, { timeZoneName: "short" })}
      >
        {clockText(props.at)}
      </time>
    </ChromeMeta>
  );
}
