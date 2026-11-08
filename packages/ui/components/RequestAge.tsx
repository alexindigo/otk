// SPDX-License-Identifier: LGPL-3.0-only
import "./RequestAge.css" with { type: "text" };

/** Shared presentation of the client owner's honest session-idle label. */
export default function RequestAge(
  props: { label: string; class?: string },
): import("solid-js").Element {
  return (
    <span
      class={["otk-request-age otk-control-label", props.class ?? ""]}
      title={props.label}
    >
      {props.label}
    </span>
  );
}
