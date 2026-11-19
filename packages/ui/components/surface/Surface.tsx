// SPDX-License-Identifier: LGPL-3.0-only
import "./Surface.css" with { type: "text" };
import ScrollRegion from "../ScrollRegion.tsx";
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
      <ScrollRegion
        borrowed={props.scrollable === false}
        frameClass="otk-surface-scroll"
        class="otk-surface-body"
      >
        {props.children}
      </ScrollRegion>
      <Show when={props.actions}>
        <footer class="otk-surface-actions">{props.actions}</footer>
      </Show>
    </div>
  );
}
