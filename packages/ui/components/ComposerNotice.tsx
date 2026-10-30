// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerNotice.css" with { type: "text" };
import type { Element } from "solid-js";
import { dynamic } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
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
  const native = nativeAttributes(() => ({ onClick: props.onClick }));
  return (
    <Control
      ref={native.ref}
      class={`otk-composer-notice-row ${props.class ?? ""}`}
      type={props.onClick ? "button" : undefined}
      role={props.role}
      aria-expanded={props.expanded === undefined
        ? undefined
        : props.expanded
        ? "true"
        : "false"}
      {...native.attributes}
    >
      <span class="otk-composer-notice-icon">{props.icon}</span>
      <span class="otk-composer-notice-content">{props.children}</span>
      {props.trailing}
    </Control>
  );
}
