// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";

/** Groups item content beside the owner's permanent in-flow pseudo-element. */
export default function SelectionContent(
  props: { children?: Element; class?: string },
): Element {
  return (
    <span class={["otk-selection-content", props.class]}>
      {props.children}
    </span>
  );
}
