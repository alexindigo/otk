// SPDX-License-Identifier: LGPL-3.0-only
import "./SidebarRail.css" with { type: "text" };
import type { Element } from "solid-js";
import ScrollRegion from "./ScrollRegion.tsx";

/** Shared column/rail geometry. Consumers supply content and actions only. */
export default function SidebarRail(props: {
  label: string;
  class?: string;
  side: "left" | "right";
  collapsed: boolean;
  width?: number;
  header?: Element;
  leading?: Element;
  /** A registered panel may already own its content's scroll boundary. */
  body?: Element;
  footer?: Element;
  resizer?: Element;
  bodyClass?: string;
  ref?(element: HTMLElement): void;
  viewport?(element: HTMLElement): void;
  children?: Element;
}): Element {
  return (
    <aside
      ref={props.ref}
      class={`otk-sidebar-rail ${props.class ?? ""}`}
      aria-label={props.label}
      data-side={props.side}
      data-collapsed={props.collapsed ? "true" : "false"}
      style={props.collapsed || props.width === undefined
        ? undefined
        : { width: `${props.width}px` }}
    >
      <header class="otk-rail-header">{props.header}</header>
      {props.leading}
      {props.body ?? (
        <ScrollRegion
          ref={props.viewport}
          class={`otk-rail-body ${props.bodyClass ?? ""}`}
        >
          {props.children}
        </ScrollRegion>
      )}
      {props.footer}
      {props.resizer}
    </aside>
  );
}
