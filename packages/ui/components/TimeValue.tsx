// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import { type TimeValue as Value, UNKNOWN_TIME } from "@otk/client";

/** Every timing consumer uses the same unknown wording and unfinished cue. */
export default function TimeValue(props: { value: Value; class?: string }) {
  return (
    <span
      class={props.class}
      title={props.value.state === "unknown"
        ? props.value.explanation
        : undefined}
    >
      <Show
        when={props.value.state === "unknown"}
        fallback={
          <>
            {props.value.state !== "unknown" ? props.value.text : undefined}
            <Show when={props.value.state === "counting"}>
              {props.value.state === "counting" && props.value.text ? " " : ""}
              <em>counting...</em>
            </Show>
          </>
        }
      >
        {UNKNOWN_TIME}
      </Show>
    </span>
  );
}
