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
  notificationBody,
  notificationFailure,
  notificationSessionLabel,
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
import { MetaItem, MetaRow } from "./MetaRow.tsx";
import { ProjectAvatar } from "./ProjectChip.tsx";
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
  let more: HTMLButtonElement | undefined, stack: HTMLElement | undefined;
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
      ref={(el) => stack = el}
      tabindex={-1}
      class={["otk-toasts", { "is-layer": props.layout === "layer" }]}
      aria-label="Notifications"
      aria-live="polite"
    >
      <Show when={remaining().length > 0}>
        <div class="otk-toasts-pager">
          <button
            ref={(el) => more = el}
            type="button"
            class="otk-toasts-more"
            onClick={() => props.model.more()}
          >
            <span class="otk-control-label" title={overflow()}>
              {overflow()}
            </span>
          </button>
        </div>
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
          const location = () => note().location;
          const locationLine = (heading: string, href?: string) => (
            <Show when={location()}>
              {(loc) => {
                const project = () =>
                  loc().project;
                const sessionLabel = () => notificationSessionLabel(loc());
                const targetLabel = (label: string) => (
                  <Show when={sessionOpen()} fallback={<span>{label}</span>}>
                    {(action) => (
                      <ActionButton
                        class="otk-toast-target"
                        href={href}
                        action={openControl(action().args, label)}
                        title={`Open ${label}`}
                        unoffered={<span>{label}</span>}
                      >
                        {label}
                      </ActionButton>
                    )}
                  </Show>
                );
                return (
                  <MetaRow whole intrinsic class="otk-toast-location">
                    <MetaItem rank={2}>
                      <strong class="otk-toast-title" title={heading}>
                        {heading}
                      </strong>
                    </MetaItem>
                    <MetaItem
                      rank={0}
                      required
                      title={project().name}
                      compactInPlace
                    >
                      <span class="otk-toast-project">
                        <ProjectAvatar {...project()} size="compact" />
                        <span class="otk-toast-project-name">
                          {project().name}
                        </span>
                      </span>
                    </MetaItem>
                    <MetaItem
                      rank={1}
                      class="otk-toast-task"
                      title={loc().task}
                    >
                      {sessionLabel() ? loc().task : targetLabel(loc().task)}
                    </MetaItem>
                    <Show when={sessionLabel()}>
                      {(label) => (
                        <MetaItem
                          rank={3}
                          class="otk-toast-session"
                          title={label()}
                        >
                          {targetLabel(label())}
                        </MetaItem>
                      )}
                    </Show>
                  </MetaRow>
                );
              }}
            </Show>
          );
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
              "aria-label": location()
                ? `${note().title}: ${notificationBody(note())}`
                : note().title,
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
                      aria-label={feedback()["aria-label"]}
                    >
                      <Show
                        when={location()}
                        fallback={
                          <>
                            <strong
                              class="otk-toast-title otk-control-label"
                              title={note().title}
                            >
                              {note().title}
                            </strong>
                            <Show when={name()}>
                              {(body) => (
                                <Show
                                  when={sessionOpen()}
                                  fallback={nameText()}
                                >
                                  {(action) => (
                                    <ActionButton
                                      class="otk-toast-target otk-control-label"
                                      action={openControl(
                                        action().args,
                                        body(),
                                      )}
                                      title={`Open ${body()}`}
                                      unoffered={nameText()}
                                    >
                                      {body()}
                                    </ActionButton>
                                  )}
                                </Show>
                              )}
                            </Show>
                          </>
                        }
                      >
                        {locationLine(note().title)}
                      </Show>
                    </div>
                  }
                >
                  {(value) => (
                    <FailureContent
                      compact
                      subgrid
                      class="otk-toast-failure"
                      placement="toast"
                      occurrence={note().id}
                      focusHome={() =>
                        (more?.isConnected ? more : stack)?.focus({
                          preventScroll: true,
                        })}
                      signal={false}
                      failure={value()}
                      heading={location() &&
                        locationLine(value().heading, value().target.href)}
                      announcement={feedback()}
                      controls={!location() && sessionOpen() && (
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
