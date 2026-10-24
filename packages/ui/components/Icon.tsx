// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
/** Shared geometry and accessibility; consumers own path data and size classes. */
export default function Icon(
  props: { children: Element; class?: string; label?: string },
): Element {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      {props.children}
    </svg>
  );
}
