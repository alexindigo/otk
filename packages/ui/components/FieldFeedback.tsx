// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import type { Element } from "solid-js";
import "./FieldFeedback.css" with { type: "text" };
import FeedbackStatus from "./FeedbackStatus.tsx";
/** The empty track remains in flow; consumers associate its ID with their field. */
export default function FieldFeedback(
  props: { id?: string; feedback?: Feedback; action?: boolean },
): Element {
  return (
    <FeedbackStatus
      id={props.id}
      class={`otk-field-feedback${props.action ? " is-action" : ""}`}
      feedback={props.feedback}
    />
  );
}
