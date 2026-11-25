// SPDX-License-Identifier: LGPL-3.0-only
import "./RequestAge.css" with { type: "text" };
import { Show } from "solid-js";
import type { RequestAgeText } from "@otk/client";
import TimeText from "./TimeText.tsx";

/** Shared presentation of the client owner's honest session-idle label. */
export default function RequestAge(
  props: { value?: RequestAgeText; class?: string },
): import("solid-js").Element {
  return (
    <Show when={props.value}>
      {(value) => (
        <span
          class={["otk-request-age otk-control-label", props.class ?? ""]}
          title={`${value().lead} ${value().time.text}`}
        >
          {value().lead} <TimeText time={value().time} />
        </span>
      )}
    </Show>
  );
}
