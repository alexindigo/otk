// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  createUniqueId,
  type Element,
  Show,
} from "solid-js";
import { dynamic } from "@solidjs/web";
import type { ActionControl, ActionOutcome, Feedback } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import { nativeAttributes } from "./native-attributes.ts";
import type { location, selection } from "./selection.ts";

/** Availability and execution are one input; callers cannot replace the handler. */
export default function ActionButton(props: {
  action: ActionControl;
  class?: string;
  label?: string;
  title?: string;
  id?: string;
  inline?: { popup?: "dialog" | "menu"; description?: string };
  expanded?: boolean;
  href?: string;
  ref?(element: HTMLElement): void;
  selection?: ReturnType<typeof selection>;
  location?: ReturnType<typeof location>;
  attributes?: {
    [attribute: `data-${string}`]: string | number | undefined;
  };
  pendingLabel?: string;
  busy?: boolean;
  unoffered?: Element;
  children: Element;
  onShown?(): void;
  /** Compact surfaces can place feedback in their existing feedback region. */
  onFeedback?(outcome: Exclude<ActionOutcome, { kind: "shown" }>): void;
}): Element {
  const [pending, setPending] = createSignal(false);
  const [feedback, setFeedback] = createSignal<Feedback>();
  const [revision, setRevision] = createSignal(0);
  createEffect(() => props.action, (action) => {
    const update = () => setRevision((value) => value + 1);
    update();
    return action.subscribe(update);
  });
  const description = `action-${createUniqueId()}`;
  const availability = () => {
    revision();
    return props.action.availability();
  };
  const unavailable = () => {
    const value = availability();
    return value.available ? undefined : value;
  };
  const busy = () => pending() || !!props.busy;
  const disabled = () => busy() || !availability().available;
  const described = () =>
    !props.onFeedback && (!!unavailable() || busy() || !!feedback());
  const activate = (event: MouseEvent | KeyboardEvent) => {
    if (disabled()) {
      event.preventDefault();
      return;
    }
    if (props.href !== undefined) {
      if (
        !(event instanceof MouseEvent) || event.button !== 0 || event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      event.preventDefault();
    }
    if (props.inline && event.currentTarget instanceof HTMLElement) {
      event.currentTarget.focus({ preventScroll: true });
    }
    event.stopPropagation();
    setPending(true);
    setFeedback(undefined);
    void props.action.run().then((result) => {
      if (result.kind === "shown") props.onShown?.();
      else if (props.onFeedback) props.onFeedback(result);
      else setFeedback(result.feedback);
    }).finally(() => setPending(false));
  };
  const native = nativeAttributes(() => ({
    ...props.attributes,
    ...props.selection,
    ...props.location,
    class: props.location?.class ?? props.selection?.class ?? props.class,
    onClick: activate,
    onKeyDown: props.inline
      ? (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!event.repeat) activate(event);
      }
      : undefined,
  }));
  // Text-flow actions need a non-atomic inline box; activation stays here.
  const Control = dynamic(() =>
    props.inline ? "span" : props.href === undefined ? "button" : "a"
  );
  return (
    <Show
      when={!unavailable()?.hidden || busy() || !!feedback()}
      fallback={props.unoffered}
    >
      <Control
        id={props.id}
        type={!props.inline && props.href === undefined ? "button" : undefined}
        href={props.href}
        role={props.inline ? "button" : undefined}
        tabindex={props.inline ? 0 : undefined}
        data-inline-action={props.inline ? "true" : undefined}
        aria-haspopup={props.inline?.popup}
        aria-description={props.inline?.description}
        ref={[(element: HTMLElement) => props.ref?.(element), native.ref]}
        {...native.attributes}
        aria-label={props.label}
        aria-expanded={props.expanded === undefined
          ? undefined
          : props.expanded
          ? "true"
          : "false"}
        title={unavailable()?.reason ?? props.title}
        disabled={!props.inline && props.href === undefined
          ? disabled()
          : undefined}
        aria-disabled={(props.inline || props.href !== undefined) && disabled()
          ? "true"
          : undefined}
        aria-busy={busy() ? "true" : "false"}
        aria-describedby={described() ? description : undefined}
      >
        {props.children}
      </Control>
      <Show when={described()}>
        <span id={description}>
          <Show when={!availability().available}>
            <ChromeMeta>{unavailable()?.reason}</ChromeMeta>
          </Show>
          <Show when={busy()}>
            <span role="status">{props.pendingLabel ?? "Working..."}</span>
          </Show>
          <Show when={feedback()}>
            {(value) => <FeedbackStatus feedback={value()} />}
          </Show>
        </span>
      </Show>
    </Show>
  );
}
