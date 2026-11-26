// SPDX-License-Identifier: LGPL-3.0-only
import "./Surface.css" with { type: "text" };
import ScrollRegion from "../ScrollRegion.tsx";
import { type Element, Show } from "solid-js";

/** Internal boundary and flow owner. Only overlay specialisations use this. */
export default function Surface(props: {
  density?: "menu" | "composer";
  layout?: "fill" | "popover" | "dialog";
  fullHeight?: boolean;
  signal?: "error" | "info";
  staticChildren?: boolean;
  scrollable?: boolean;
  title?: Element;
  titleAction?: Element;
  actions?: Element;
  children: Element;
}): Element {
  return (
    <div
      class={["otk-surface", {
        "otk-surface-menu": props.density === "menu",
        "otk-surface-composer": props.density === "composer",
        "is-fill": props.layout === "fill" || props.layout === "dialog",
        "is-dialog": props.layout === "dialog",
        "is-popover": props.layout === "popover",
        "is-full-height": props.fullHeight,
        "has-static-children": props.staticChildren,
      }]}
      data-signal={props.signal}
    >
      <Show when={props.title || props.titleAction}>
        <header class="otk-surface-title">
          {props.title}
          <Show when={props.titleAction}>
            {(action) => <div class="otk-surface-title-action">{action()}</div>}
          </Show>
        </header>
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
