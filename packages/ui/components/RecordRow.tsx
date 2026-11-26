// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import ContentSlot from "./ContentSlot.tsx";
import FittedActions, { type FittedAction } from "./FittedActions.tsx";
import FailureSignal from "./FailureSignal.tsx";
import "./RecordRow.css" with { type: "text" };

/** Shared inline record layout; consumers supply presentation and callbacks. */
export default function RecordRow(props: {
  class?: string;
  icon(): Element;
  children: Element;
  status?(): Element;
  actions?: readonly FittedAction[];
  failed?: boolean;
  outgoing?: boolean;
}): Element {
  return (
    <div
      class={["otk-record-row", props.class, {
        "is-outgoing": props.outgoing,
        "has-action-slot": props.actions !== undefined,
      }]}
    >
      <FailureSignal
        as="div"
        placement="gutter"
        enabled={props.failed === true}
        class="otk-record-row-grid"
      >
        {props.icon()}
        <div class="otk-record-row-label">{props.children}</div>
        <Show when={props.status}>
          <div class="otk-record-row-status">
            <ContentSlot content={props.status} />
          </div>
        </Show>
        <Show when={props.actions?.length}>
          <div class="otk-record-row-actions">
            <FittedActions inline items={props.actions ?? []} />
          </div>
        </Show>
      </FailureSignal>
    </div>
  );
}
