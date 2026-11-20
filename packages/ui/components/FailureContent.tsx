// SPDX-License-Identifier: LGPL-3.0-only
import type { FailurePresentation, Feedback } from "@otk/client";
import { Show } from "solid-js";
import { ChevronIcon } from "./ChromeIcons.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import "./FailureContent.css" with { type: "text" };

/** One presentation of failure facts. Containers choose density, never wording. */
export default function FailureContent(props: {
  failure: FailurePresentation;
  action?: Feedback["action"];
  onReveal?(messageID: string): void;
  compact?: boolean;
  time?: number;
  /** Compatibility with single-line feedback tracks. */
  inline?: boolean;
}) {
  const compact = () => props.compact || props.inline;
  const reason = () => (
    <div class="otk-failure-body">
      <p class="otk-failure-reason">{props.failure.reason}</p>
      <Show when={props.failure.recovery}>
        {(recovery) => <p class="otk-failure-recovery">{recovery()}</p>}
      </Show>
    </div>
  );
  const diagnostic = () => (
    <div class="otk-failure-diagnostic">
      <Show
        when={props.failure.value.diagnosticID !== "validation"}
        fallback={<span>No diagnostic ID supplied</span>}
      >
        <span>Diagnostic ID</span>
        <code
          class="otk-control-label"
          title={props.failure.value.diagnosticID}
        >
          {props.failure.value.diagnosticID}
        </code>
      </Show>
    </div>
  );
  return (
    <div
      class={["otk-failure-content", {
        "is-compact": compact(),
        "is-informational": props.failure.tone === "info",
        "is-reference": !!props.failure.reference,
      }]}
    >
      <Show
        when={props.failure.reference}
        fallback={
          <>
            <div class="otk-failure-heading">
              <strong class="otk-control-label" title={props.failure.heading}>
                {props.failure.heading}
              </strong>
              <Show when={props.failure.target.label}>
                <Show
                  when={props.failure.target.href}
                  fallback={
                    <span
                      class="otk-failure-target otk-control-label"
                      title={props.failure.target.label}
                    >
                      {props.failure.target.label}
                    </span>
                  }
                >
                  <a
                    class="otk-failure-target otk-control-label"
                    href={props.failure.target.href}
                    title={props.failure.target.label}
                  >
                    {props.failure.target.label}
                  </a>
                </Show>
              </Show>
              <Show
                when={props.time === undefined
                  ? undefined
                  : new Date(props.time)}
              >
                {(time) => (
                  <ChromeMeta class="otk-failure-time otk-control-label">
                    <time
                      datetime={time().toISOString()}
                      title={time().toLocaleString(undefined, {
                        timeZoneName: "short",
                      })}
                    >
                      {time().toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </ChromeMeta>
                )}
              </Show>
            </div>
            <div class="otk-failure-main-reason">{reason()}</div>
            <Show when={props.failure.count > 1}>
              <span class="otk-failure-count">
                {props.failure.count} identical{" "}
                {props.failure.tone === "info" ? "notices" : "failures"}
              </span>
            </Show>
            <div class="otk-failure-controls">
              <Show when={props.action}>
                {(action) => (
                  <button
                    type="button"
                    onClick={() => action().run()}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
              <details class="otk-failure-details">
                <summary>
                  <ControlIcon>
                    <ChevronIcon />
                  </ControlIcon>
                  <span>Details</span>
                </summary>
                <ScrollRegion axis="y" class="otk-failure-detail-body">
                  <div class="otk-failure-disclosed-reason">{reason()}</div>
                  {diagnostic()}
                </ScrollRegion>
              </details>
            </div>
          </>
        }
      >
        {(reference) => (
          <a
            class="otk-control-label"
            title={reference().label}
            href={props.failure.target.href}
            onClick={(event) => {
              if (!props.onReveal) return;
              event.preventDefault();
              props.onReveal(reference().messageID);
            }}
          >
            {reference().label}
          </a>
        )}
      </Show>
    </div>
  );
}
