// SPDX-License-Identifier: LGPL-3.0-only
import "./Toasts.css" with { type: "text" };
import {
  createEffect,
  createSignal,
  type Element,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { CloseIcon } from "./ChromeIcons.tsx";
import { type Note, notificationFailure, type Selection } from "@otk/client";
import type { ToastsModel } from "../features/notify/toast.ts";
import Toast from "./surface/Toast.tsx";
import RequestAge from "./RequestAge.tsx";
import FailureContent from "./FailureContent.tsx";
import { feedbackState } from "./feedback-state.ts";
import { nativeAttributes } from "./native-attributes.ts";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import { sessionTargetOpenControl } from "./session-open.ts";
export default function Toasts(
  props: { model: ToastsModel; detail?(note: Note): Element; onMore(): void },
): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const [items, setItems] = createSignal(props.model.state.items);
  const limit = 3;
  const [offset, setOffset] = createSignal(0);
  const overflow = () => {
    const remaining = items().filter((_item, index) =>
      index < offset() || index >= offset() + limit
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
  onCleanup(props.model.subscribe((state) => setItems(state.items)));
  createEffect(() => items(), () => {
    setOffset(0);
  });
  return (
    <section
      class="otk-toasts"
      aria-label="Notifications"
      aria-live="polite"
    >
      <For
        each={items().slice(offset(), offset() + limit)}
        keyed={(item) => item.note.id}
      >
        {(item) => {
          const feedback = nativeAttributes(() => {
            const semantics = feedbackState({
              feedback: {
                kind: item().note.kind === "error" ? "error" : "info",
                text: item().note.title,
              },
            });
            // Toast owns its surface paint; feedback owns the announcement.
            return {
              role: semantics.role,
              "aria-atomic": semantics["aria-atomic"],
            };
          });
          return (
            <Toast id={item().note.id} kind={item().note.kind}>
              <header class="otk-toast-header">
                <div
                  class="otk-toast-message otk-disclosure-layout"
                  {...feedback.attributes}
                  ref={feedback.ref}
                  aria-label={item().note.title}
                >
                  <Show
                    when={notificationFailure(item().note)}
                    fallback={
                      <>
                        <strong
                          class="otk-toast-title otk-control-label"
                          title={item().note.title}
                        >
                          {item().note.title}
                        </strong>
                        <Show when={item().note.body}>
                          <span
                            class="otk-toast-body otk-control-label"
                            title={item().note.body}
                          >
                            {item().note.body}
                          </span>
                        </Show>
                      </>
                    }
                  >
                    {(failure) => (
                      <FailureContent
                        compact
                        subgrid
                        signal={false}
                        failure={failure()}
                      />
                    )}
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
              <RequestAge class="otk-toast-age" value={item().note.context} />
              {props.detail?.(item().note)}
              <div class="otk-toast-actions">
                <For each={item().note.actions}>
                  {(action) => (
                    <Show
                      when={action.command === "session.open"}
                      fallback={
                        <button
                          type="button"
                          title={action.description}
                          aria-description={action.description}
                          onClick={() => void item().delivery.invoke(action)}
                        >
                          {action.label}
                        </button>
                      }
                    >
                      <ActionButton
                        action={sessionTargetOpenControl(
                          commands,
                          action.args as Selection,
                          item().note.title,
                          item().delivery.current,
                        )}
                        title={action.description}
                      >
                        {action.label}
                      </ActionButton>
                    </Show>
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
          );
        }}
      </For>
      <Show when={items().length > limit}>
        <button
          type="button"
          class="otk-toasts-more"
          onClick={() => {
            setOffset(
              offset() + limit >= items().length ? 0 : offset() + limit,
            );
          }}
        >
          {overflow()}
        </button>
      </Show>
    </section>
  );
}
