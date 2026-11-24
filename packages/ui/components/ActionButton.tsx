// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  createUniqueId,
  type Element,
  Show,
} from "solid-js";
import { dynamic } from "@solidjs/web";
import type { ActionControl, Feedback } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import { nativeAttributes } from "./native-attributes.ts";
import type { selection } from "./selection.ts";

/** Availability and execution are one input; callers cannot replace the handler. */
export default function ActionButton(props: {
  action: ActionControl;
  class?: string;
  label?: string;
  title?: string;
  href?: string;
  ref?(element: HTMLElement): void;
  selection?: ReturnType<typeof selection>;
  attributes?: {
    [attribute: `data-${string}`]: string | number | undefined;
  };
  pendingLabel?: string;
  busy?: boolean;
  children: Element;
  onShown?(): void;
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
  const described = () => !!unavailable() || busy() || !!feedback();
  const activate = (event: MouseEvent) => {
    if (props.href !== undefined) {
      if (disabled()) {
        event.preventDefault();
        return;
      }
      if (
        event.button !== 0 || event.ctrlKey || event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      event.preventDefault();
    }
    event.stopPropagation();
    setPending(true);
    setFeedback(undefined);
    void props.action.run().then((result) => {
      if (result.kind === "shown") props.onShown?.();
      else setFeedback(result.feedback);
    }).finally(() => setPending(false));
  };
  const native = nativeAttributes(() => ({
    ...props.attributes,
    ...props.selection,
    class: props.selection?.class ?? props.class,
    onClick: activate,
  }));
  const Control = dynamic(() => props.href === undefined ? "button" : "a");
  return (
    <Show when={!unavailable()?.hidden || busy() || !!feedback()}>
      <Control
        type={props.href === undefined ? "button" : undefined}
        href={props.href}
        ref={[(element: HTMLElement) => props.ref?.(element), native.ref]}
        {...native.attributes}
        aria-label={props.label}
        title={unavailable()?.reason ?? props.title}
        disabled={props.href === undefined ? disabled() : undefined}
        aria-disabled={props.href !== undefined && disabled()
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
