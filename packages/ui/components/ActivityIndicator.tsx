// SPDX-License-Identifier: LGPL-3.0-only
import "./ActivityIndicator.css" with { type: "text" };
import StateShape from "./StateShape.tsx";
/** In-progress work, without assigning a session attention/completion state. */
export default function ActivityIndicator(
  props: { small?: boolean; label?: string; decorative?: boolean },
): import("solid-js").Element {
  return (
    <span
      class="otk-activity-indicator"
      data-small={props.small || undefined}
      role={props.decorative ? undefined : "img"}
      aria-hidden={props.decorative ? "true" : undefined}
      aria-label={props.decorative ? undefined : props.label ?? "Working"}
      title={props.decorative ? undefined : props.label ?? "Working"}
    >
      <span class="otk-activity-spinner" aria-hidden="true" />
      <StateShape class="otk-activity-shape" kind="half-disc" />
    </span>
  );
}
