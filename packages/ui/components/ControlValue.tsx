// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import "./ControlValue.css" with { type: "text" };
/** One square icon track, derived from the owning control's height and border. */
export function ControlIcon(
  props: { children: Element; class?: string },
): Element {
  return <span class={["otk-control-icon", props.class]}>{props.children}
  </span>;
}
/** Content only: the control owns its height; the trailing square owns centring. */
export default function ControlValue(
  props: { children?: Element; accessory: Element },
): Element {
  return (
    <span class="otk-control-value">
      <span class="otk-control-value-label">{props.children}</span>
      <span class="otk-control-accessory" aria-hidden="true">
        {props.accessory}
      </span>
    </span>
  );
}
