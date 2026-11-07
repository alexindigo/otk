// SPDX-License-Identifier: LGPL-3.0-only
import "./Surface.css" with { type: "text" };
import { scrollRegion } from "../ScrollRegion.tsx";
import { type Element, Show } from "solid-js";

/** Internal boundary and flow owner. Only overlay specialisations use this. */
export default function Surface(props: {
  density?: "menu";
  scrollable?: boolean;
  title?: Element;
  actions?: Element;
  children: Element;
}): Element {
  return (
    <div
      class={["otk-surface", { "otk-surface-menu": props.density === "menu" }]}
    >
      <Show when={props.title}>
        <header class="otk-surface-title">{props.title}</header>
      </Show>
      <div
        class={[
          props.scrollable !== false && scrollRegion(),
          "otk-surface-body",
        ]}
      >
        {props.children}
      </div>
      <Show when={props.actions}>
        <footer class="otk-surface-actions">{props.actions}</footer>
      </Show>
    </div>
  );
}
