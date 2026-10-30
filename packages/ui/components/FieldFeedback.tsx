// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import type { Element } from "solid-js";
import "./FieldFeedback.css" with { type: "text" };
/** The empty track remains in flow; consumers associate its ID with their field. */
export default function FieldFeedback(
  props: { id?: string; feedback?: Feedback; action?: boolean },
): Element {
  return (
    <div
      id={props.id}
      class={`otk-field-feedback${props.feedback ? " is-visible" : ""}${
        props.feedback?.kind === "error" ? " is-error" : ""
      }${props.action ? " is-action" : ""}`}
      role={props.feedback?.kind === "error" ? "alert" : "status"}
      aria-hidden={props.feedback ? undefined : "true"}
      title={props.feedback?.text}
    >
      <span>{props.feedback?.text ?? "\u00a0"}</span>
    </div>
  );
}
