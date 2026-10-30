// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { ActivityIcon, CloseIcon } from "./ChromeIcons.tsx";
import "./OperationFeedback.css" with { type: "text" };
import { feedbackState } from "./feedback-state.ts";

/** Content only: its consumer owns the one joined notice frame and target. */
export default function OperationFeedback(
  props: {
    feedback: Feedback;
    icon?: Element;
    control?(control: { focus(): void }): void;
  },
): Element {
  return (
    <ComposerNoticeRow
      focusable
      control={props.control}
      icon={props.icon ??
        (props.feedback.kind === "error" ? <CloseIcon /> : <ActivityIcon />)}
      {...feedbackState({
        feedback: props.feedback,
        class: "otk-operation-feedback",
      })}
      trailing={
        <Show when={props.feedback.action}>
          <button type="button" onClick={() => props.feedback.action?.run()}>
            {props.feedback.action?.label}
          </button>
        </Show>
      }
    >
      <span class="otk-control-label" title={props.feedback.text}>
        {props.feedback.text}
      </span>
    </ComposerNoticeRow>
  );
}
