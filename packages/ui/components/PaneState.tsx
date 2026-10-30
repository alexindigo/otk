// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import "./PaneState.css" with { type: "text" };
/** Data and callbacks only; the transcript owner supplies this shared grid cell. */
export default function PaneState(props: { feedback: Feedback }): Element {
  return (
    <div
      class={`otk-pane-state is-${props.feedback.kind}`}
      role={props.feedback.kind === "error" ? "alert" : "status"}
    >
      <p>{props.feedback.text}</p>
      <Show when={props.feedback.action}>
        <button type="button" onClick={() => props.feedback.action?.run()}>
          {props.feedback.action?.label}
        </button>
      </Show>
    </div>
  );
}
