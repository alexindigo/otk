// SPDX-License-Identifier: LGPL-3.0-only
import { usageCost } from "@otk/client";

/** Data-only money text; visible cents and exact, title-free accessible detail. */
export default function UsageCost(
  props: { value: number },
): import("solid-js").Element {
  return (
    <span
      class="otk-usage-cost"
      role="group"
      aria-label={usageCost(props.value)}
      aria-description={`Exact cost: ${usageCost(props.value, "exact")}`}
    >
      {usageCost(props.value)}
    </span>
  );
}
