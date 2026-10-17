// SPDX-License-Identifier: LGPL-3.0-only
import "./Menu.css" with { type: "text" };
import type { Element } from "solid-js";
import Popover from "./Popover.tsx";

export default function Menu(props: {
  label: string;
  trigger: Element;
  class?: string;
  children: Element;
}): Element {
  return (
    <Popover
      label={props.label}
      trigger={props.trigger}
      class={`otk-menu ${props.class ?? ""}`}
      dismissOnAction
    >
      <div class="otk-menu-items">{props.children}</div>
    </Popover>
  );
}
