// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, type Element, onSettled } from "solid-js";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { focusControl } from "../keyboard/focus.ts";
import "./ActionSlot.css" with { type: "text" };

/** The action and its real pending label both size the same normal-flow cell. */
export default function ActionSlot(props: {
  pending: boolean;
  pendingLabel: string;
  /** While pending, only the invoked slot in a group shows its status. */
  showStatus?: boolean;
  class?: string;
  align?: "end";
  children: Element;
  control?(control: { focus(): void }): void;
  focusAction?(): void;
}): Element {
  let status!: HTMLDivElement;
  const showStatus = () => props.pending && (props.showStatus ?? true);
  createEffect(showStatus, (visible, previous) => {
    if (previous && !visible && document.activeElement === status) {
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
        class="otk-action-slot-feedback"
        focusable
        inactive={!showStatus()}
        feedback={{ kind: "pending", text: props.pendingLabel }}
        ref={(element) => {
          status = element;
          props.control?.({
            focus: () => {
              if (showStatus()) focusControl(element, { focusVisible: false });
            },
          });
        }}
      />
    </div>
  );
}
