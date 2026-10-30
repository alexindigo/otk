// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import { ComposerNoticeRow } from "./ComposerNotice.tsx";
import "./OperationFeedback.css" with { type: "text" };

/** Content only: its consumer owns the one joined notice frame and target. */
export default function OperationFeedback(
  props: { feedback: Feedback; icon?: Element },
): Element {
  return (
    <ComposerNoticeRow
      icon={
        <span class="otk-operation-feedback-icon" aria-hidden="true">
          {props.icon ?? "•"}
        </span>
      }
      role={props.feedback.kind === "error" ? "alert" : "status"}
      class={`otk-operation-feedback is-${props.feedback.kind}`}
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
