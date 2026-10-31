// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";
import { createEffect, type Element, onSettled } from "solid-js";
import FeedbackStatus from "./FeedbackStatus.tsx";
import "./ActionSlot.css" with { type: "text" };

/** One normal-flow cell preserves the action's geometry while status owns it. */
export default function ActionSlot(props: {
  pending: boolean;
  feedback?: Feedback;
  class?: string;
  align?: "end";
  children: Element;
  control?(control: { focus(): void }): void;
  focusAction?(): void;
}): Element {
  let status!: HTMLDivElement;
  createEffect(() => props.pending, (pending, previous) => {
    if (previous && !pending && document.activeElement === status) {
      onSettled(() => props.focusAction?.());
    }
  });
  return (
    <div
      class={["otk-action-slot", props.class, { "is-pending": props.pending }]}
      data-align={props.align}
    >
      <div class="otk-action-slot-control">{props.children}</div>
      <FeedbackStatus
        focusable
        feedback={props.feedback}
        ref={(element) => {
          status = element;
          props.control?.({
            focus: () => {
              if (
                element.isConnected && element.getClientRects().length
              ) element.focus();
            },
          });
        }}
      />
    </div>
  );
}
