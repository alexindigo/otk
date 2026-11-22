// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import "./DisclosureToggle.css" with { type: "text" };

export function DisclosureIcon(props: { open?: boolean }): Element {
  return (
    <span class="otk-disclosure-icon" aria-hidden="true">
      <svg viewBox="0 0 9 9" fill="none">
        <rect x=".5" y=".5" width="8" height="8" />
        <path d="M2.5 4.5h4" />
        <Show when={!props.open}>
          <path d="M4.5 2.5v4" />
        </Show>
      </svg>
    </span>
  );
}

/** Decorative junction for a header's existing button; shares the same owned
 * tree geometry as the independent disclosure button. */
export function DisclosureLabel(
  props: { open?: boolean; for: string; label?: string },
): Element {
  return (
    <label
      class="otk-disclosure-toggle otk-tree-toggle"
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
  onOpen(open: boolean): void;
}): Element {
  return (
    <button
      type="button"
      class={["otk-disclosure-toggle", props.class, {
        "otk-tree-toggle": props.variant === "tree",
        "otk-meta-toggle": props.variant === "meta",
      }]}
      data-record-kind={props["data-record-kind"]}
      aria-label={props.label}
      aria-expanded={props.open ? "true" : "false"}
      onClick={() => props.onOpen(!props.open)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        props.onOpen(event.key === "ArrowRight");
      }}
    >
      <DisclosureIcon open={props.open} />
      {props.children}
    </button>
  );
}
