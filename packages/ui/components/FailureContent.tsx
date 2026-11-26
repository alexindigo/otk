// SPDX-License-Identifier: LGPL-3.0-only
import type { FailurePresentation, Feedback } from "@otk/client";
import { createSignal, type Element, Show } from "solid-js";
import DisclosureToggle from "./DisclosureToggle.tsx";
import Clock from "./Clock.tsx";
import FailureSignal, { type FailureAnnouncement } from "./FailureSignal.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import { ActivityIcon, AlertIcon, CloseIcon } from "./ChromeIcons.tsx";
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
      /** An expanded disclosure keeps the full reason visible at every width. */
      expanded?: boolean;
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
      announcement?: FailureAnnouncement;
      class?: string;
    }
    & ({ placement?: "record" } | {
      placement: "feedback";
      row(input: FailureFeedbackRow): Element;
      icon?(): Element;
      onDismiss?(): void;
    }),
) {
  const compact = () => props.compact || props.inline;
  const [open, setOpen] = createSignal(false);
  const toggle = () => (
    <DisclosureToggle
      class="otk-failure-details"
      label="Details"
      open={open()}
      onOpen={setOpen}
    >
      <span class="otk-failure-detail-toggle">Details</span>
    </DisclosureToggle>
  );
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
      return [
        ...(props.action ? [{ key: "recover", ...props.action }] : []),
        {
          key: "details",
          label: "Details",
          expanded: open(),
          run: () => setOpen((value) => !value),
        },
        ...(props.onDismiss
          ? [{
            key: "dismiss",
            label: "Dismiss notice",
            icon: CloseIcon,
            run: props.onDismiss,
          }]
          : []),
      ];
    };
    return (
      <div
        class={["otk-failure-content is-feedback", {
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
        <Show when={open() && !reference()}>
          <div class="otk-failure-detail-track">{detailBody()}</div>
        </Show>
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
        props.expanded ? "is-expanded" : "",
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
              <Show when={props.controls} fallback={toggle()}>
                <div class="otk-failure-control-row">
                  {toggle()}
                  {props.controls}
                </div>
              </Show>
              <Show when={open()}>{detailBody()}</Show>
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
