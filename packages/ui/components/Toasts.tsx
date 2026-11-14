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
import { type Note, notificationFailure } from "@otk/client";
import type { ToastsModel } from "../features/notify/toast.ts";
import Toast from "./surface/Toast.tsx";
import RequestAge from "./RequestAge.tsx";
import FailureContent from "./FailureContent.tsx";
export default function Toasts(
  props: { model: ToastsModel; detail?(note: Note): Element; onMore(): void },
): import("solid-js").Element {
  const [items, setItems] = createSignal(props.model.state.items);
  const [limit, setLimit] = createSignal(3);
  const [offset, setOffset] = createSignal(0);
  const overflow = () => {
    const remaining = items().filter((_item, index) =>
      index < offset() || index >= offset() + limit()
    );
    const failures = remaining.filter((item) => item.note.kind === "error")
      .reduce(
        (count, item) => count + (notificationFailure(item.note)?.count ?? 1),
        0,
      );
    const attention =
      remaining.filter((item) =>
        item.note.kind === "permission" || item.note.kind === "question"
      ).length;
    const other =
      remaining.filter((item) =>
        !["error", "permission", "question"].includes(item.note.kind)
      ).length;
    return [
      failures
        ? `${failures} more ${failures === 1 ? "failure" : "failures"}`
        : "",
      attention ? `${attention} more need you` : "",
      other ? `${other} more notifications` : "",
    ].filter(Boolean).join(", ");
  };
  let stack!: HTMLElement;
  onCleanup(props.model.subscribe((state) => setItems(state.items)));
  const fit = () => {
    if (stack.getBoundingClientRect().top < 0 && limit() > 1) {
      setLimit(limit() - 1);
    }
  };
  createEffect(() => items(), () => {
    setLimit(3);
    setOffset(0);
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
        each={items().slice(offset(), offset() + limit())}
        keyed={(item) => item.note.id}
      >
        {(item) => (
          <Toast id={item().note.id} kind={item().note.kind}>
            <header class="otk-toast-header">
              <div class="otk-toast-message">
                <Show
                  when={notificationFailure(item().note)}
                  fallback={
                    <>
                      <strong
                        class="otk-control-label"
                        title={item().note.title}
                      >
                        {item().note.title}
                      </strong>
                      <Show when={item().note.body}>
                        <span
                          class="otk-control-label"
                          title={item().note.body}
                        >
                          {item().note.body}
                        </span>
                      </Show>
                    </>
                  }
                >
                  {(failure) => <FailureContent failure={failure()} />}
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
              <RequestAge class="otk-toast-age" label={item().note.context!} />
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
            setOffset(
              offset() + limit() >= items().length ? 0 : offset() + limit(),
            );
          }}
        >
          {overflow()}
        </button>
      </Show>
    </section>
  );
}
