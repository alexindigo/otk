// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, type Feedback, validationFeedback } from "@otk/client";
import { createMemo, type Element, Show } from "solid-js";
import { feedbackState } from "./feedback-state.ts";
import { nativeAttributes } from "./native-attributes.ts";
import FailureContent from "./FailureContent.tsx";
import "./FeedbackStatus.css" with { type: "text" };

/** In-flow status with an optional owner-supplied action. No request lifetime. */
export type FeedbackInput = string | Feedback | undefined;
export default function FeedbackStatus(props: {
  feedback?: Feedback;
  error?: FeedbackInput;
  validation?: string;
  id?: string;
  class?: string;
  ref?(element: HTMLDivElement): void;
  focusable?: boolean;
  /** Hide the status without removing its intrinsic contribution to layout. */
  inactive?: boolean;
  singleLine?: boolean;
  compact?: boolean;
  summaryOnly?: boolean;
  fullReason?: boolean;
  time?: number;
  placement?: "record" | "field";
  subgrid?: boolean;
  intrinsic?: boolean;
  onReveal?(messageID: string): void;
}): Element {
  const feedback = createMemo((): Feedback | undefined =>
    props.validation
      ? validationFeedback(props.validation)
      : errorFeedback(props.feedback ?? props.error)
  );
  let frame: HTMLDivElement | undefined;
  const native = nativeAttributes(() =>
    feedbackState({
      feedback: feedback(),
      inactive: props.inactive,
      class: `otk-feedback-status ${props.subgrid ? "uses-subgrid" : ""} ${
        props.singleLine ? "is-single-line" : ""
      } ${props.validation ? "is-validation" : ""} ${props.class ?? ""}`,
    })
  );
  return (
    <div
      {...native.attributes}
      id={props.id}
      ref={(el) => {
        frame = el;
        native.ref(el);
        props.ref?.(el);
      }}
      tabindex={props.focusable || feedback()?.failure ? -1 : undefined}
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
              summaryOnly={props.summaryOnly}
              fullReason={props.fullReason}
              focusHome={() => frame?.focus({ preventScroll: true })}
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
