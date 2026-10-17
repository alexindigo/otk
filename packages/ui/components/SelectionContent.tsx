// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";

/** A permanent leading lane and an ordinary flowing row of item content. */
export default function SelectionContent(
  props: { children?: Element; class?: string },
): Element {
  return (
    <>
      <span class="otk-selection-lane" aria-hidden="true">
        <span class="otk-selection-marker" />
      </span>
      <span class={["otk-selection-content", props.class]}>
        {props.children}
      </span>
    </>
  );
}
