// SPDX-License-Identifier: LGPL-3.0-only
import "./Toasts.css" with { type: "text" };
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { ToastsModel } from "../features/notify/toast.ts";
import Toast from "./surface/Toast.tsx";
export default function Toasts(
  props: { model: ToastsModel },
): import("solid-js").Element {
  const [items, setItems] = createSignal(props.model.state.items);
  onCleanup(props.model.subscribe((state) => setItems(state.items)));
  return (
    <section class="otk-toasts" aria-label="Notifications" aria-live="polite">
      <For
        each={items()}
        keyed={(item) =>
          item.note.id}
      >
        {(item) => (
          <Toast id={item().note.id} kind={item().note.kind}>
            <button
              type="button"
              class="otk-toast-message"
              title="Dismiss notification"
              onClick={() => item().delivery.dismiss()}
            >
              <strong>{item().note.title}</strong>
              <Show when={item().note.body}>
                <span>{item().note.body}</span>
              </Show>
            </button>
            <Show when={item().note.actions.length}>
              <div class="otk-toast-actions">
                <For each={item().note.actions}>
                  {(action) => (
                    <button
                      type="button"
                      onClick={() => void item().delivery.invoke(action)}
                    >
                      {action.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Toast>
        )}
      </For>
    </section>
  );
}
