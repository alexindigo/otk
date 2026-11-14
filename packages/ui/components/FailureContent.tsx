// SPDX-License-Identifier: LGPL-3.0-only
import type { FailurePresentation } from "@otk/client";
import { Show } from "solid-js";
import "./FailureContent.css" with { type: "text" };

/** Every failure surface renders the owner's value, including its target link. */
export default function FailureContent(
  props: { failure: FailurePresentation },
) {
  return (
    <span class="otk-failure-content">
      <span>
        {props.failure.heading} for{" "}
        <Show
          when={props.failure.target.href}
          fallback={<span>{props.failure.target.label}</span>}
        >
          <a href={props.failure.target.href}>{props.failure.target.label}</a>
        </Show>.
      </span>
      <span>{props.failure.reason}</span>
      <span>{props.failure.recovery}</span>
      <Show when={props.failure.count > 1}>
        <span>{props.failure.count} identical failures</span>
      </Show>
      <Show when={props.failure.generic}>
        <span class="otk-failure-details">
          Details: diagnostic ID {props.failure.value.diagnosticID}
        </span>
      </Show>
    </span>
  );
}
