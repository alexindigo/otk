// SPDX-License-Identifier: LGPL-3.0-only
import "./Toasts.css" with { type: "text" };
import {
  createEffect,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { CloseIcon } from "./ChromeIcons.tsx";
import type { Note } from "@otk/client";
import type { ToastsModel } from "../features/notify/toast.ts";
import Toast from "./surface/Toast.tsx";
export default function Toasts(
  props: { model: ToastsModel; detail?(note: Note): Element; onMore(): void },
): import("solid-js").Element {
  const [items, setItems] = createSignal(props.model.state.items);
  const [limit, setLimit] = createSignal(3);
  let stack!: HTMLElement;
  onCleanup(props.model.subscribe((state) => setItems(state.items)));
  const fit = () => {
    if (stack.getBoundingClientRect().top < 0 && limit() > 0) {
      setLimit(limit() - 1);
    }
  };
  createEffect(() => items(), () => {
    setLimit(3);
  });
  onSettled(() => {
    const observer = new ResizeObserver(fit);
    observer.observe(stack);
    const resize = () => {
      setLimit(3);
      fit();
    };
    globalThis.addEventListener("resize", resize);
    onCleanup(() => {
      observer.disconnect();
      globalThis.removeEventListener("resize", resize);
    });
  });
  return (
    <section
      ref={stack}
      class="otk-toasts"
      aria-label="Notifications"
      aria-live="polite"
    >
      <For
        each={items().slice(0, limit())}
        keyed={(item) => item.note.id}
      >
        {(item) => (
          <Toast id={item().note.id} kind={item().note.kind}>
            <header class="otk-toast-header">
              <div class="otk-toast-message">
                <strong class="otk-control-label" title={item().note.title}>
                  {item().note.title}
                </strong>
                <Show when={item().note.body}>
                  <span class="otk-control-label" title={item().note.body}>
                    {item().note.body}
                  </span>
                </Show>
              </div>
              <button
                type="button"
                class="otk-icon-button otk-toast-close"
                aria-label="Close notification"
                title="Dismiss notification"
                onClick={() => item().delivery.dismiss()}
              >
                <CloseIcon />
              </button>
            </header>
            <Show when={item().note.context}>
              <span
                class="otk-toast-age otk-control-label"
                title={item().note.context}
              >
                {item().note.context}
              </span>
            </Show>
            {props.detail?.(item().note)}
            <div class="otk-toast-actions">
              <For each={item().note.actions}>
                {(action) => (
                  <button
                    type="button"
                    title={action.description}
                    aria-description={action.description}
                    onClick={() => void item().delivery.invoke(action)}
                  >
                    {action.label}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="otk-toast-dismiss"
                onClick={() => item().delivery.dismiss()}
              >
                Dismiss
              </button>
            </div>
          </Toast>
        )}
      </For>
      <Show when={items().length > limit()}>
        <button
          type="button"
          class="otk-toasts-more"
          onClick={() => {
            props.onMore();
            for (const item of items()) item.delivery.dismiss();
          }}
        >
          {items().length - limit()} more need you
        </button>
      </Show>
    </section>
  );
}
