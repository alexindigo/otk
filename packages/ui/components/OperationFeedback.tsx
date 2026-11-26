// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, type Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { ActivityIcon } from "./ChromeIcons.tsx";
import "./OperationFeedback.css" with { type: "text" };
import { feedbackState } from "./feedback-state.ts";
import FailureContent, { type FailureFeedbackRow } from "./FailureContent.tsx";

/** Content only: its consumer owns the one joined notice frame and target. */
export default function OperationFeedback(
  props: {
    feedback: Feedback;
    icon?: () => Element;
    control?(control: { focus(): void }): void;
    onReveal?(messageID: string): void;
    onDismiss?(): void;
  },
): Element {
  const feedback = () => errorFeedback(props.feedback)!;
  const row = (content: FailureFeedbackRow) => (
    <ComposerNoticeRow
      focusable
      control={props.control}
      icon={content.icon}
      {...feedbackState({
        feedback: feedback(),
        class: "otk-operation-feedback",
      })}
      actions={content.actions}
    >
      {content.label}
    </ComposerNoticeRow>
  );
  return (
    <Show
      when={feedback().failure}
      fallback={row({
        icon: () => props.icon?.() ?? <ActivityIcon />,
        label: (
          <span class="otk-control-label" title={props.feedback.text}>
            {props.feedback.text}
          </span>
        ),
        get actions() {
          return props.feedback.action
            ? [{ key: "recover", ...props.feedback.action }]
            : [];
        },
      })}
    >
      {(failure) => (
        <FailureContent
          failure={failure()}
          action={feedback().action}
          onReveal={props.onReveal}
          onDismiss={props.onDismiss}
          icon={props.icon}
          placement="feedback"
          row={row}
        />
      )}
    </Show>
  );
}
