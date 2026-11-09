// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import { ControlIcon } from "./ControlValue.tsx";

/** Groups item content beside the owner's permanent in-flow pseudo-element. */
export default function SelectionContent(
  props: { children?: Element; class?: string; leading?: Element },
): Element {
  return (
    <span class={["otk-selection-content", props.class]}>
      <Show when={props.leading}>
        <ControlIcon>{props.leading}</ControlIcon>
      </Show>
      {props.children}
    </span>
  );
}
