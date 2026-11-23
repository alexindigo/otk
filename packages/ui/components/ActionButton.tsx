// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  createUniqueId,
  type Element,
  Show,
} from "solid-js";
import type { ActionControl, Feedback } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ChromeMeta from "./ChromeMeta.tsx";

/** Availability and execution are one input; callers cannot replace the handler. */
export default function ActionButton(props: {
  action: ActionControl;
  class?: string;
  label?: string;
  title?: string;
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
  const described = () => !!unavailable() || pending() || !!feedback();
  return (
    <Show when={!unavailable()?.hidden || pending() || !!feedback()}>
      <button
        type="button"
        class={props.class}
        aria-label={props.label}
        title={unavailable()?.reason ?? props.title}
        disabled={pending() || !availability().available}
        aria-busy={pending() ? "true" : "false"}
        aria-describedby={described() ? description : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setPending(true);
          setFeedback(undefined);
          void props.action.run().then((result) => {
            if (result.kind === "shown") props.onShown?.();
            else setFeedback(result.feedback);
          }).finally(() => setPending(false));
        }}
      >
        {props.children}
      </button>
      <Show when={described()}>
        <span id={description}>
          <Show when={!availability().available}>
            <ChromeMeta>{unavailable()?.reason}</ChromeMeta>
          </Show>
          <Show when={pending()}>
            <span role="status">Working...</span>
          </Show>
          <Show when={feedback()}>
            {(value) => <FeedbackStatus feedback={value()} />}
          </Show>
        </span>
      </Show>
    </Show>
  );
}
