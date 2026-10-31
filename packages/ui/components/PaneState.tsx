// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import type { Element } from "solid-js";
import FeedbackStatus from "./FeedbackStatus.tsx";
import "./PaneState.css" with { type: "text" };
/** Data and callbacks only; the transcript owner supplies this shared grid cell. */
export default function PaneState(
  props: { feedback?: Feedback; children?: Element },
): Element {
  return (
    <div class="otk-pane-state">
      <div class="otk-pane-state-content">
        {props.feedback
          ? <FeedbackStatus feedback={props.feedback} />
          : props.children}
      </div>
    </div>
  );
}
