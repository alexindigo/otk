// SPDX-License-Identifier: LGPL-3.0-only
import type { ActionControl, ActionOutcome, HistoryTarget } from "@otk/client";
import type { Element } from "solid-js";
import { ArrowLeftIcon, ArrowRightIcon } from "./ChromeIcons.tsx";
import ActionButton from "./ActionButton.tsx";
import "./HistoryButtons.css" with { type: "text" };

export default function HistoryButtons(props: {
  back: HistoryTarget;
  forward: HistoryTarget;
  backAction: ActionControl;
  forwardAction: ActionControl;
  onFeedback(outcome: Exclude<ActionOutcome, { kind: "shown" }>): void;
}): Element {
  return (
    <nav class="otk-history" aria-label="Session history">
      <ActionButton
        class="otk-icon-button"
        action={props.backAction}
        label={props.back.label}
        title={props.back.label}
        attributes={{ "data-state": props.back.state }}
        onFeedback={props.onFeedback}
      >
        <ArrowLeftIcon />
      </ActionButton>
      <ActionButton
        class="otk-icon-button"
        action={props.forwardAction}
        label={props.forward.label}
        title={props.forward.label}
        attributes={{ "data-state": props.forward.state }}
        onFeedback={props.onFeedback}
      >
        <ArrowRightIcon />
      </ActionButton>
    </nav>
  );
}
