// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For, Show } from "solid-js";
import type { TimeText as Value } from "@otk/client";
import "./TimeText.css" with { type: "text" };

/** The only renderer of time text: structured parts, natural accessible name. */
export default function TimeText(
  props: { time: Value; class?: string; title?: string; suffix?: string },
): Element {
  return (
    <time
      class={["otk-time", props.class]}
      datetime={props.time.iso}
      aria-label={props.time.spoken}
      title={props.title}
    >
      <Show
        when={props.time.word}
        fallback={
          <For
            each={props.time.parts}
            keyed={(part) => part.unit}
          >
            {(part, index) => (
              <>
                {index() ? " " : ""}
                <span class="otk-time-part">
                  <span class="otk-time-value">{part().value}</span>
                  <span class="otk-time-unit" data-unit={part().unit}>
                    <span>{part().unit}</span>
                  </span>
                </span>
              </>
            )}
          </For>
        }
      >
        <span class="otk-time-value">{props.time.word}</span>
      </Show>
      <Show when={props.suffix}>
        {(suffix) => <span aria-hidden="true">{` ${suffix()}`}</span>}
      </Show>
    </time>
  );
}
