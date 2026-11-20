// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, type Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { ActivityIcon } from "./ChromeIcons.tsx";
import "./OperationFeedback.css" with { type: "text" };
import { feedbackState } from "./feedback-state.ts";
import FailureContent from "./FailureContent.tsx";

/** Content only: its consumer owns the one joined notice frame and target. */
export default function OperationFeedback(
  props: {
    feedback: Feedback;
    icon?: Element;
    control?(control: { focus(): void }): void;
    onReveal?(messageID: string): void;
  },
): Element {
  const feedback = () => errorFeedback(props.feedback)!;
  return (
    <ComposerNoticeRow
      focusable
      control={props.control}
      icon={props.icon ??
        (feedback().failure ? null : <ActivityIcon />)}
      {...feedbackState({
        feedback: props.feedback,
        class: "otk-operation-feedback",
      })}
      trailing={
        <Show when={!feedback().failure && props.feedback.action}>
          <button type="button" onClick={() => props.feedback.action?.run()}>
            {props.feedback.action?.label}
          </button>
        </Show>
      }
    >
      {feedback().failure
        ? (
          <FailureContent
            failure={feedback().failure!}
            action={feedback().action}
            onReveal={props.onReveal}
          />
        )
        : (
          <span class="otk-control-label" title={props.feedback.text}>
            {props.feedback.text}
          </span>
        )}
    </ComposerNoticeRow>
  );
}
