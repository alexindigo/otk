// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import "./ChromeMeta.css" with { type: "text" };

/** Quiet product-owned chrome metadata, shared with the project's visit clock. */
export default function ChromeMeta(
  props: { children: Element; class?: string },
): Element {
  return <span class={["otk-chrome-meta", props.class]}>{props.children}</span>;
}

/** Labels and adjacent meta are separate slots, never concatenated copy. */
export function SectionHeaderMeta(
  props: { label: string; count: number; metaClass?: string },
): Element {
  return (
    <>
      <span class="otk-control-label" title={props.label}>{props.label}</span>
      <ChromeMeta class={props.metaClass}>{props.count}</ChromeMeta>
    </>
  );
}
