// SPDX-License-Identifier: LGPL-3.0-only
import "./Diagnostics.css" with { type: "text" };
import { For, Show } from "solid-js";
import type { Diagnostic } from "@otk/protocol";
import { errorFeedback } from "@otk/client";
import FeedbackStatus from "../FeedbackStatus.tsx";
export default function Diagnostics(props: { items: Diagnostic[] }) {
  return (
    <Show when={props.items.length > 0}>
      <ul class="otk-diagnostics">
        <For each={props.items} keyed={false}>
          {(item) => (
            <li data-severity={item().severity}>
              <Show
                when={item().severity === "error"}
                fallback={
                  <>
                    {item().severity} [{item().line}:{item().col}]{" "}
                    {item().message}
                  </>
                }
              >
                <FeedbackStatus
                  compact
                  feedback={errorFeedback(item().message, {
                    actionLabel: "Checking code",
                    target: {
                      label: `Line ${item().line}, column ${item().col}`,
                    },
                  })}
                />
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
