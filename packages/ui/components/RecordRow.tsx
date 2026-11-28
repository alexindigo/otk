// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import ContentSlot from "./ContentSlot.tsx";
import FittedActions, { type FittedAction } from "./FittedActions.tsx";
import FailureSignal from "./FailureSignal.tsx";
import { MetaRow } from "./MetaRow.tsx";
import "./RecordRow.css" with { type: "text" };

/** Shared inline record layout; consumers supply presentation and callbacks. */
export default function RecordRow(props: {
  class?: string;
  /** The consumer's grid can reserve an intrinsic track for these accessories. */
  intrinsic?: boolean;
  icon?(): Element;
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
        "has-icon": !!props.icon,
        "has-action-slot": props.actions !== undefined,
        "is-intrinsic": props.intrinsic,
      }]}
    >
      <FailureSignal
        as="div"
        placement="gutter"
        enabled={props.failed === true}
        class="otk-record-row-grid"
      >
        <Show when={props.icon}>
          <ContentSlot content={props.icon} />
        </Show>
        <div class="otk-record-row-main">
          <div class="otk-record-row-label">{props.children}</div>
          <Show when={props.status}>
            <div class="otk-record-row-status">
              <MetaRow whole intrinsic class="otk-record-row-facts">
                <ContentSlot content={props.status} />
              </MetaRow>
            </div>
          </Show>
        </div>
        <Show when={props.actions?.length}>
          <div class="otk-record-row-actions">
            <FittedActions inline items={props.actions ?? []} />
          </div>
        </Show>
      </FailureSignal>
    </div>
  );
}
