// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, type Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import { feedbackState } from "./feedback-state.ts";
import { nativeAttributes } from "./native-attributes.ts";
import FailureContent from "./FailureContent.tsx";
import "./FeedbackStatus.css" with { type: "text" };

/** In-flow status with an optional owner-supplied action. No request lifetime. */
export type FeedbackInput = string | Feedback | undefined;
export default function FeedbackStatus(props: {
  feedback?: Feedback;
  error?: FeedbackInput;
  id?: string;
  class?: string;
  ref?(element: HTMLDivElement): void;
  focusable?: boolean;
  singleLine?: boolean;
  compact?: boolean;
  time?: number;
  placement?: "record";
  subgrid?: boolean;
  intrinsic?: boolean;
  onReveal?(messageID: string): void;
}): Element {
  const feedback = () => errorFeedback(props.feedback ?? props.error);
  const native = nativeAttributes(() =>
    feedbackState({
      feedback: feedback(),
      class: `otk-feedback-status ${props.subgrid ? "uses-subgrid" : ""} ${
        props.singleLine ? "is-single-line" : ""
      } ${props.class ?? ""}`,
    })
  );
  return (
    <div
      {...native.attributes}
      id={props.id}
      ref={[props.ref, native.ref]}
      tabindex={props.focusable ? -1 : undefined}
      aria-label={feedback()?.text}
    >
      <div
        class={feedback()?.failure
          ? "otk-feedback-text"
          : "otk-feedback-text otk-control-label"}
      >
        {feedback()?.failure
          ? (
            <FailureContent
              failure={feedback()!.failure!}
              inline={props.singleLine}
              compact={props.compact}
              time={props.time}
              placement={props.placement}
              subgrid={props.subgrid}
              intrinsic={props.intrinsic}
              action={feedback()?.action}
              onReveal={props.onReveal}
            />
          )
          : feedback()?.text ?? "\u00a0"}
      </div>
      <Show when={!feedback()?.failure && feedback()?.action}>
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
