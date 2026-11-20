// SPDX-License-Identifier: LGPL-3.0-only
import { dynamic } from "@solidjs/web";
import type { Element } from "solid-js";
import "./FailureSignal.css" with { type: "text" };

/** Shared failure stripe; an enclosing surface can own it instead. */
export default function FailureSignal(props: {
  as?: "div" | "span";
  class?: string;
  enabled?: boolean;
  informational?: boolean;
  children: Element;
}): Element {
  const Frame = dynamic(() => props.as ?? "span");
  return (
    <Frame
      class={[props.class, {
        "otk-failure-signal": props.enabled !== false,
        "is-informational": props.informational,
      }]}
    >
      {props.children}
    </Frame>
  );
}
