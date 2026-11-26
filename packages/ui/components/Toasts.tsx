// SPDX-License-Identifier: LGPL-3.0-only
import "./Toasts.css" with { type: "text" };
import {
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { CloseIcon } from "./ChromeIcons.tsx";
import {
  type EntityStateStore,
  lamp,
  type Note,
  notificationFailure,
  type Selection,
} from "@otk/client";
import { entityKey } from "@otk/protocol";
import type { ToastsModel } from "../features/notify/toast.ts";
import Toast from "./surface/Toast.tsx";
import RequestAge from "./RequestAge.tsx";
import FailureContent from "./FailureContent.tsx";
import { feedbackState } from "./feedback-state.ts";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import { sessionTargetOpenControl } from "./session-open.ts";
import StatusLight from "./StatusLight.tsx";
export default function Toasts(
  props: {
    model: ToastsModel;
    detail?(note: Note): Element;
    entities?(sidecar: string): EntityStateStore | undefined;
    layout?: "layer";
    onMore(): void;
  },
): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const [revision, setRevision] = createSignal(0);
  onCleanup(props.model.subscribe(() => setRevision((n) => n + 1)));
  const visible = createMemo(() => {
    revision();
    return props.model.visible();
  });
  const remaining = createMemo(() => {
    revision();
    return props.model.remaining();
  });
  const overflow = () => {
    const items = remaining();
    const failures = items.filter((item) => item.note.kind === "error")
      .reduce(
        (count, item) => count + (notificationFailure(item.note)?.count ?? 1),
        0,
      );
    const attention =
      items.filter((item) =>
        item.note.kind === "permission" || item.note.kind === "question"
      ).length;
    const other =
      items.filter((item) =>
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
  return (
    <section
      class={["otk-toasts", { "is-layer": props.layout === "layer" }]}
      aria-label="Notifications"
      aria-live="polite"
    >
      <Show when={remaining().length > 0}>
        <button
          type="button"
          class="otk-toasts-more"
          onClick={() => props.model.more()}
        >
          {overflow()}
        </button>
      </Show>
      <For
        each={visible()}
        keyed={(item) => item.note.id}
      >
        {(item) => {
          const note = () => item().note;
          const failure = createMemo(() => notificationFailure(note()));
          const signal = () => {
            const value = failure();
            return value && (value.tone === "info" ? "info" : "error");
          };
          const session = () =>
            !failure() && props.entities && note().sessionRef;
          const sessionOpen = () => {
            const offers = note().actions.filter(({ command }) =>
              command === "session.open"
            );
            return offers.find((action) => action.default) ?? offers[0];
          };
          const actions = () =>
            note().actions.filter((action) => action !== sessionOpen());
          const openControl = (args: unknown, label: string) =>
            sessionTargetOpenControl(
              commands,
              args as Selection,
              label,
              item().delivery.current,
            );
          const name = () =>
            note().body ?? (sessionOpen() ? note().title : undefined);
          const nameText = () => (
            <span class="otk-toast-target otk-control-label" title={name()}>
              {name()}
            </span>
          );
          const detail = createMemo(() => props.detail?.(note()));
          const feedback = () => {
            const semantics = feedbackState({
              feedback: {
                kind: note().kind === "error" ? "error" : "info",
                text: note().title,
              },
            });
            // Toast owns its surface paint; feedback owns the announcement.
            return {
              role: semantics.role,
              "aria-atomic": semantics["aria-atomic"],
              "aria-label": note().title,
            };
          };
          return (
            <Toast
              id={note().id}
              kind={note().kind}
              lead={!!(session() || failure())}
              signal={signal()}
              onHold={(held) => props.model.hold(note().id, held)}
            >
              <div class="otk-toast-row">
                <Show when={session()}>
                  {(ref) => (
                    <span class="otk-toast-lead">
                      <StatusLight
                        state={lamp(
                          props.entities?.(ref().sidecar),
                          entityKey("session", ref().session),
                        )}
                      />
                    </span>
                  )}
                </Show>
                <Show
                  when={failure()}
                  fallback={
                    <div
                      class="otk-toast-line"
                      role={feedback().role}
                      aria-atomic={feedback()["aria-atomic"]}
                      aria-label={note().title}
                    >
                      <strong
                        class="otk-toast-title otk-control-label"
                        title={note().title}
                      >
                        {note().title}
                      </strong>
                      <Show when={name()}>
                        {(body) => (
                          <Show when={sessionOpen()} fallback={nameText()}>
                            {(action) => (
                              <ActionButton
                                class="otk-toast-target otk-control-label"
                                action={openControl(action().args, body())}
                                title={`Open ${body()}`}
                                unoffered={nameText()}
                              >
                                {body()}
                              </ActionButton>
                            )}
                          </Show>
                        )}
                      </Show>
                    </div>
                  }
                >
                  {(value) => (
                    <FailureContent
                      compact
                      subgrid
                      class="otk-toast-failure"
                      signal={false}
                      failure={value()}
                      announcement={feedback()}
                      controls={sessionOpen() && (
                        <Show when={sessionOpen()}>
                          {(action) => (
                            <div class="otk-toast-failure-action">
                              <ActionButton
                                class="otk-toast-action otk-control-label"
                                action={openControl(
                                  action().args,
                                  value().target.label ?? action().label,
                                )}
                                title={action().description}
                              >
                                {action().label}
                              </ActionButton>
                            </div>
                          )}
                        </Show>
                      )}
                    />
                  )}
                </Show>
                <button
                  type="button"
                  class="otk-icon-button otk-toast-close"
                  aria-label="Dismiss notification"
                  title="Dismiss notification"
                  onClick={() => item().delivery.dismiss()}
                >
                  <CloseIcon />
                </button>
                <Show when={detail()}>
                  {(content) => <div class="otk-toast-more">{content()}</div>}
                </Show>
                <Show when={note().context || actions().length}>
                  <div class="otk-toast-more otk-toast-foot">
                    <RequestAge class="otk-toast-age" value={note().context} />
                    <Show when={actions().length}>
                      <div class="otk-toast-foot-actions">
                        <For each={actions()}>
                          {(action) => (
                            <button
                              class="otk-toast-action otk-control-label"
                              type="button"
                              title={action.description}
                              aria-description={action.description}
                              onClick={() =>
                                void item().delivery.invoke(action)}
                            >
                              {action.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Toast>
          );
        }}
      </For>
    </section>
  );
}
