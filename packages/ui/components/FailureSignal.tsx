// SPDX-License-Identifier: LGPL-3.0-only
import { dynamic } from "@solidjs/web";
import type { Element } from "solid-js";
import type { feedbackState } from "./feedback-state.ts";
import "./FailureSignal.css" with { type: "text" };

export type FailureAnnouncement =
  & Pick<ReturnType<typeof feedbackState>, "role" | "aria-atomic">
  & { "aria-label": string };

/** Shared failure stripe; an enclosing surface can own it instead. */
export default function FailureSignal(props: {
  as?: "div" | "span";
  class?: string;
  enabled?: boolean;
  informational?: boolean;
  placement?: "gutter";
  announcement?: FailureAnnouncement;
  children: Element;
}): Element {
  const Frame = dynamic(() => props.as ?? "span");
  return (
    <Frame
      role={props.announcement?.role}
      aria-label={props.announcement?.["aria-label"]}
      aria-atomic={props.announcement?.["aria-atomic"]}
      class={[props.class, {
        "otk-failure-signal": props.enabled !== false,
        "is-informational": props.informational,
        "is-gutter": props.placement === "gutter",
      }]}
    >
      {props.children}
    </Frame>
  );
}
