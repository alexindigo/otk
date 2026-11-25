// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import { type TimeValue as Value, UNKNOWN_TIME } from "@otk/client";
import TimeText from "./TimeText.tsx";

/** Every timing consumer uses the same unknown wording and unfinished cue. */
export default function TimeValue(props: { value: Value; class?: string }) {
  const time = () =>
    props.value.state === "unknown" ? undefined : props.value.time;
  const lead = () =>
    props.value.state === "unknown" ? undefined : props.value.lead;
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
            <Show when={time()}>
              {(value) => (
                <>
                  {lead() ? `${lead()} ` : ""}
                  <TimeText time={value()} />
                </>
              )}
            </Show>
            <Show when={props.value.state === "counting"}>
              {time() ? " " : ""}
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
