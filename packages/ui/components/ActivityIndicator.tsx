// SPDX-License-Identifier: LGPL-3.0-only
import "./ActivityIndicator.css" with { type: "text" };
/** In-progress work, without assigning a session attention/completion state. */
export default function ActivityIndicator(
  props: { small?: boolean; label?: string },
): import("solid-js").Element {
  return (
    <span
      class="otk-activity-indicator"
      data-small={props.small || undefined}
      role="img"
      aria-label={props.label ?? "Working"}
      title={props.label ?? "Working"}
    >
      <span class="otk-activity-spinner" aria-hidden="true" />
      <span class="otk-activity-shape" aria-hidden="true">◐</span>
    </span>
  );
}
