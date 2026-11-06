// SPDX-License-Identifier: LGPL-3.0-only
import "./ProgressStatus.css" with { type: "text" };
/** Data-only single-line status, shared by shell, crumbs, Sessions and pages. */
export default function ProgressStatus(
  props: { text: string; class?: string },
): import("solid-js").Element {
  return (
    <span
      class={["otk-progress-status otk-control-label", props.class]}
      role="status"
      aria-live="polite"
      title={props.text}
    >
      {props.text}
    </span>
  );
}
