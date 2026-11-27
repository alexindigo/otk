// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import { DisclosureIcon } from "./Disclosure.tsx";
import "./DisclosureToggle.css" with { type: "text" };

export { DisclosureIcon };

/** Decorative junction for a header's existing button; shares the same owned
 * tree geometry as the independent disclosure button. */
export function DisclosureLabel(
  props: { open?: boolean; for: string; label?: string },
): Element {
  return (
    <label
      class="otk-disclosure-toggle otk-tree-toggle"
      data-disclosure-variant="tree"
      for={props.for}
      aria-label={props.label}
      aria-hidden="true"
    >
      <DisclosureIcon open={props.open} />
    </label>
  );
}

/** One focus target and one SVG vocabulary for tree and independent disclosures. */
export default function DisclosureToggle(props: {
  open?: boolean;
  label: string;
  class?: string;
  variant?: "tree" | "meta";
  "data-record-kind"?: string;
  children?: Element;
  onOpen(open: boolean, event: MouseEvent | KeyboardEvent): void;
}): Element {
  return (
    <button
      type="button"
      class={["otk-disclosure-toggle", props.class, {
        "otk-tree-toggle": props.variant === "tree",
        "otk-meta-toggle": props.variant === "meta",
      }]}
      data-disclosure-variant={props.variant}
      data-record-kind={props["data-record-kind"]}
      aria-label={props.label}
      aria-expanded={props.open ? "true" : "false"}
      onClick={(event) => props.onOpen(!props.open, event)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        props.onOpen(event.key === "ArrowRight", event);
      }}
    >
      <DisclosureIcon open={props.open} />
      {props.children}
    </button>
  );
}
