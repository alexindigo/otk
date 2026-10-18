// SPDX-License-Identifier: LGPL-3.0-only
import "./Takeover.css" with { type: "text" };
import type { Element } from "solid-js";
import Surface from "./Surface.tsx";

/**
 * The composer-area surface for approvals and questions: same box as the
 * composer. Collapsed, it keeps only its title and a one-line body.
 */
export default function Takeover(props: {
  title: Element;
  actions?: Element;
  collapsed?: boolean;
  children: Element;
}): Element {
  return (
    <div
      class="otk-takeover"
      data-collapsed={props.collapsed ? "true" : "false"}
    >
      <Surface
        title={props.title}
        actions={props.collapsed ? undefined : props.actions}
      >
        {props.children}
      </Surface>
    </div>
  );
}
