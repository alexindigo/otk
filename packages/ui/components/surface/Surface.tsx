// SPDX-License-Identifier: LGPL-3.0-only
import "./Surface.css" with { type: "text" };
import { type Element, Show } from "solid-js";

/** Internal boundary and flow owner. Only overlay specialisations use this. */
export default function Surface(props: {
  title?: Element;
  actions?: Element;
  children: Element;
}): Element {
  return (
    <div class="otk-surface">
      <Show when={props.title}>
        <header class="otk-surface-title">{props.title}</header>
      </Show>
      <div class="otk-surface-body">{props.children}</div>
      <Show when={props.actions}>
        <footer class="otk-surface-actions">{props.actions}</footer>
      </Show>
    </div>
  );
}
