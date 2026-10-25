// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerNotice.css" with { type: "text" };
import type { Element } from "solid-js";
import { dynamic } from "@solidjs/web";
/** Shared joined notice frame; content and actions belong to its consumer. */
export default function ComposerNotice(props: { children: Element }): Element {
  return <div class="otk-composer-notice">{props.children}</div>;
}

/** One primary notice row for facts, disclosures and failures. */
export function ComposerNoticeRow(props: {
  icon: Element;
  children: Element;
  trailing?: Element;
  class?: string;
  role?: "alert" | "status";
  expanded?: boolean;
  onClick?(): void;
}): Element {
  const Control = dynamic(() => props.onClick ? "button" : "div");
  return (
    <Control
      class={`otk-composer-notice-row ${props.class ?? ""}`}
      type={props.onClick ? "button" : undefined}
      role={props.role}
      aria-expanded={props.expanded === undefined
        ? undefined
        : props.expanded
        ? "true"
        : "false"}
      onClick={props.onClick}
    >
      {props.icon}
      <span class="otk-composer-notice-content">{props.children}</span>
      {props.trailing}
    </Control>
  );
}
