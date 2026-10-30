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
  "aria-atomic"?: "true";
  "aria-hidden"?: "true";
  focusable?: boolean;
  control?(control: { focus(): void }): void;
  expanded?: boolean;
  onClick?(): void;
}): Element {
  const Control = dynamic(() => props.onClick ? "button" : "div");
  const native = nativeAttributes(() => ({ onClick: props.onClick }));
  return (
    <Control
      ref={(element: HTMLElement) => {
        native.ref(element);
        props.control?.({
          focus: () => {
            if (element.isConnected && element.getClientRects().length) {
              element.focus();
            }
          },
        });
      }}
      tabindex={props.focusable ? -1 : undefined}
      class={`otk-composer-notice-row ${props.class ?? ""}`}
      type={props.onClick ? "button" : undefined}
      role={props.role}
      aria-atomic={props["aria-atomic"]}
      aria-hidden={props["aria-hidden"]}
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
