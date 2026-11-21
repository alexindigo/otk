// SPDX-License-Identifier: LGPL-3.0-only
import type { FailurePresentation, Feedback } from "@otk/client";
import { createSignal, Show } from "solid-js";
import DisclosureToggle from "./DisclosureToggle.tsx";
import Clock from "./Clock.tsx";
import FailureSignal from "./FailureSignal.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import "./FailureContent.css" with { type: "text" };

/** One presentation of failure facts. Containers choose density, never wording. */
export default function FailureContent(props: {
  failure: FailurePresentation;
  action?: Feedback["action"];
  onReveal?(messageID: string): void;
  compact?: boolean;
  time?: number;
  /** The surrounding row already supplies the action and target heading. */
  placement?: "record";
  /** A containing surface may own the failure signal on its outer edge. */
  signal?: boolean;
  /** Compatibility with single-line feedback tracks. */
  inline?: boolean;
  /** Borrow a containing owner's signal/content tracks without offset math. */
  subgrid?: boolean;
  /** Size to the facts instead of filling an already bounded feedback track. */
  intrinsic?: boolean;
}) {
  const compact = () => props.compact || props.inline;
  const [open, setOpen] = createSignal(false);
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
    <FailureSignal
      as="div"
      placement="gutter"
      enabled={props.signal !== false && !props.failure.reference &&
        props.failure.tone !== "neutral"}
      informational={props.failure.tone === "info"}
      class={[
        "otk-failure-content",
        "otk-disclosure-layout",
        compact() ? "is-compact" : "",
        props.failure.reference ? "is-reference" : "",
        props.placement === "record" ? "is-record" : "",
        props.subgrid ? "uses-subgrid" : "",
        props.intrinsic ? "is-intrinsic" : "",
      ].filter(Boolean).join(" ")}
    >
      <Show
        when={props.failure.reference}
        fallback={
          <>
            <Show when={props.placement !== "record"}>
              <div class="otk-failure-heading">
                <Show when={props.placement !== "record"}>
                  <strong
                    class="otk-control-label"
                    title={props.failure.heading}
                  >
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
                </Show>
                <Show when={props.time !== undefined}>
                  <Clock
                    at={props.time!}
                    class="otk-failure-time otk-control-label"
                  />
                </Show>
              </div>
            </Show>
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
                    class="otk-failure-action"
                    type="button"
                    onClick={() => action().run()}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
              <DisclosureToggle
                class="otk-failure-details"
                label="Details"
                open={open()}
                onOpen={setOpen}
              >
                <span class="otk-failure-detail-toggle">Details</span>
              </DisclosureToggle>
              <Show when={open()}>
                <ScrollRegion axis="y" class="otk-failure-detail-body">
                  <div class="otk-failure-disclosed-reason">{reason()}</div>
                  <Show
                    when={props.placement === "record" &&
                      props.time !== undefined}
                  >
                    <Clock at={props.time!} class="otk-failure-time" />
                  </Show>
                  {diagnostic()}
                </ScrollRegion>
              </Show>
            </div>
          </>
        }
      >
        {(reference) => (
          <Show
            when={props.onReveal}
            fallback={<span>{reference().label}</span>}
          >
            {(reveal) => (
              <button
                class="otk-failure-reference otk-control-label"
                type="button"
                title={reference().label}
                onClick={() => reveal()(reference().messageID)}
              >
                {reference().label}
              </button>
            )}
          </Show>
        )}
      </Show>
    </FailureSignal>
  );
}
