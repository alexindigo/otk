// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import { feedbackState } from "./feedback-state.ts";
import { nativeAttributes } from "./native-attributes.ts";
import "./FeedbackStatus.css" with { type: "text" };

/** In-flow status with an optional owner-supplied action. No request lifetime. */
export default function FeedbackStatus(props: {
  feedback?: Feedback;
  id?: string;
  class?: string;
  ref?(element: HTMLDivElement): void;
  focusable?: boolean;
}): Element {
  const native = nativeAttributes(() =>
    feedbackState({
      feedback: props.feedback,
      class: `otk-feedback-status ${props.class ?? ""}`,
    })
  );
  return (
    <div
      {...native.attributes}
      id={props.id}
      ref={[props.ref, native.ref]}
      tabindex={props.focusable ? -1 : undefined}
      aria-label={props.feedback?.text}
      title={props.feedback?.text}
    >
      <p class="otk-feedback-text otk-control-label">
        {props.feedback?.text ?? "\u00a0"}
      </p>
      <Show when={props.feedback?.action}>
        {(action) => (
          <button
            type="button"
            onClick={() => action().run()}
          >
            {action().label}
          </button>
        )}
      </Show>
    </div>
  );
}
