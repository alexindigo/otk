// SPDX-License-Identifier: LGPL-3.0-only
import type { FailurePresentation, Feedback } from "@otk/client";
import { type Element, Show } from "solid-js";
import Disclosure from "./Disclosure.tsx";
import Clock from "./Clock.tsx";
import FailureSignal, { type FailureAnnouncement } from "./FailureSignal.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import { ActivityIcon, AlertIcon } from "./ChromeIcons.tsx";
import type { FittedAction } from "./FittedActions.tsx";
import "./FailureContent.css" with { type: "text" };

export interface FailureFeedbackRow {
  icon(): Element;
  label: Element;
  actions: readonly FittedAction[];
}

/** One presentation of failure facts. Containers choose density, never wording. */
export default function FailureContent(
  props:
    & {
      failure: FailurePresentation;
      action?: Feedback["action"];
      onReveal?(messageID: string): void;
      compact?: boolean;
      summaryOnly?: boolean;
      fullReason?: boolean;
      occurrence?: string;
      focusHome?(): void;
      time?: number;
      /** A containing surface may own the failure signal on its outer edge. */
      signal?: boolean;
      /** Compatibility with single-line feedback tracks. */
      inline?: boolean;
      /** Borrow a containing owner's signal/content tracks without offset math. */
      subgrid?: boolean;
      /** Size to the facts instead of filling an already bounded feedback track. */
      intrinsic?: boolean;
      /** An optional trailing action shares the Details row. */
      controls?: Element;
      /** A containing surface can supply its own target presentation. */
      heading?: Element;
      announcement?: FailureAnnouncement;
      class?: string;
    }
    & ({ placement?: "record" | "inline" | "field" | "toast" } | {
      placement: "feedback";
      row(input: FailureFeedbackRow): Element;
      icon?(): Element;
    }),
) {
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
  const detailBody = () => (
    <ScrollRegion axis="y" class="otk-failure-detail-body">
      <div class="otk-failure-disclosed-reason">{reason()}</div>
      <Show when={props.placement === "record" && props.time !== undefined}>
        <Clock at={props.time!} class="otk-failure-time" />
      </Show>
      {diagnostic()}
      <Show when={props.failure.details}>
        {(details) => <p class="otk-failure-diagnostic">{details()}</p>}
      </Show>
    </ScrollRegion>
  );
  const details = () => (
    <div class="otk-failure-details">
      <Disclosure
        trackAligned={props.placement === "record" && props.subgrid}
        kind="failureDetails"
        variant="label"
        identity={{
          scope: props.occurrence ?? props.failure.occurrence,
          id: props.placement === "feedback"
            ? "notice"
            : props.placement ?? "inline",
        }}
        label="Details"
        hasContent={() => true}
        focusHome={props.focusHome}
      >
        {detailBody}
      </Disclosure>
    </div>
  );
  if (props.placement === "feedback") {
    const reference = () => props.failure.reference;
    // The producer's retained reference distinguishes a refused prompt from a
    // prompt that was sent successfully but failed during its run.
    const notSent = () =>
      reference()?.label === "Not sent - see the error above";
    const prefix = () => notSent() ? "Not sent. " : "";
    const description = () => {
      const { heading, target, reason } = props.failure;
      return reference()
        ? `${prefix()}${heading}`
        : `${heading}${target.label ? ` for ${target.label}` : ""}: ${reason}`;
    };
    const actions = (): readonly FittedAction[] => {
      const record = reference();
      if (record) {
        return props.onReveal
          ? [{
            key: "reveal",
            label: "Show error",
            class: "otk-failure-reference",
            run: () => props.onReveal?.(record.messageID),
          }]
          : [];
      }
      return props.action ? [{ key: "recover", ...props.action }] : [];
    };
    return (
      <div
        class={["otk-failure-content otk-disclosure-layout is-feedback", {
          "is-error": props.failure.tone === "error",
        }]}
      >
        {props.row({
          icon: () =>
            props.icon?.() ??
              (props.failure.tone === "error"
                ? <AlertIcon />
                : <ActivityIcon />),
          get actions() {
            return actions();
          },
          label: (
            <span class="otk-control-label" title={description()}>
              {prefix()}
              <span class="otk-failure-heading">{props.failure.heading}</span>
              <Show when={!reference()}>
                {props.failure.target.label
                  ? ` for ${props.failure.target.label}`
                  : ""}:{" "}
                <span class="otk-failure-summary-reason">
                  {props.failure.reason}
                </span>
              </Show>
            </span>
          ),
        })}
        <Show when={!reference()}>{details()}</Show>
      </div>
    );
  }
  return (
    <FailureSignal
      as="div"
      announcement={props.announcement}
      placement="gutter"
      enabled={props.signal !== false && !props.failure.reference &&
        props.failure.tone !== "neutral"}
      informational={props.failure.tone === "info"}
      class={[
        "otk-failure-content",
        props.class,
        "otk-disclosure-layout",
        compact() ? "is-compact" : "",
        props.fullReason ? "shows-full-reason" : "",
        props.summaryOnly ? "is-summary-only" : "",
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
                <Show
                  when={props.heading}
                  fallback={
                    <>
                      <strong
                        class="otk-control-label"
                        title={props.summaryOnly &&
                            props.failure.reason !== props.failure.heading
                          ? `${props.failure.heading}: ${props.failure.reason}`
                          : props.failure.heading}
                      >
                        {props.failure.heading}
                      </strong>
                      <Show
                        when={!props.summaryOnly && props.failure.target.label}
                      >
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
                    </>
                  }
                >
                  {props.heading}
                </Show>
                <Show
                  when={props.summaryOnly &&
                    props.failure.reason !== props.failure.heading}
                >
                  <span
                    class="otk-failure-summary-reason otk-control-label"
                    title={props.failure.reason}
                  >
                    {props.failure.reason}
                  </span>
                </Show>
                <Show when={props.time !== undefined}>
                  <Clock
                    at={props.time!}
                    class="otk-failure-time otk-control-label"
                  />
                </Show>
              </div>
            </Show>
            <Show when={!props.summaryOnly}>
              <div class="otk-failure-main-reason">{reason()}</div>
            </Show>
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
              <Show when={!props.summaryOnly}>{details()}</Show>
              {props.controls}
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
