// SPDX-License-Identifier: LGPL-3.0-only
import {
  createSignal,
  type Element as SolidElement,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  createForm,
  createPrimaryAction,
  errorFeedback,
  type FailureValue,
  failureValue,
  forgetForm,
} from "@otk/client";
import PrimaryAction from "./PrimaryAction.tsx";
import { bindPrimaryAction } from "../state/primary-action.ts";
import type { FormAnswer, FormRequest } from "@otk/protocol";
import { solidState } from "../state/binding.ts";
import Takeover from "./surface/Takeover.tsx";
import TakeoverHeader from "./TakeoverHeader.tsx";
import RequestDismiss from "./RequestDismiss.tsx";
import { bindDirtyInput } from "../state/dirty-input.ts";
import FeedbackStatus from "./FeedbackStatus.tsx";
import FormField from "./FormField.tsx";
import { useShellPorts } from "../shell/context.tsx";
import type {
  SurfaceRegistry,
  TakeoverDefinition,
} from "../registries/shell.ts";
import { useSessionPorts } from "../registries/session.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import "./QuestionDock.css" with { type: "text" };
import "./FormDock.css" with { type: "text" };
export function registerGlobalForms(
  registry: SurfaceRegistry<
    import("../registries/shell.ts").GlobalSurfaceDefinition
  >,
): void {
  registry.register({
    id: "forms",
    capability: "forms",
    component: () => {
      const shell = useShellPorts();
      return (
        <div class="otk-global-forms">
          <For each={shell.servers()} keyed={(server) => server.id}>
            {(server) => (
              <>
                <For
                  each={shell.forms?.(server().id).filter((f) =>
                    f.owner.kind === "location" &&
                    shell.connection(server().id).attention.get("form", f.id)
                      ?.dismissed
                  ) ?? []}
                  keyed={(f) => f.id}
                >
                  {(request) => (
                    <button
                      type="button"
                      class="otk-pill"
                      onClick={() =>
                        shell.connection(server().id).attention.show(
                          "form",
                          request().id,
                        )}
                    >
                      Pending form: reopen
                    </button>
                  )}
                </For>
                <For
                  each={shell.forms?.(server().id).filter((f) =>
                    f.owner.kind === "location" &&
                    !shell.connection(server().id).attention.get("form", f.id)
                      ?.dismissed
                  ).slice(0, 1) ?? []}
                  keyed={(f) => f.id}
                >
                  {(request) => (
                    <FormDock
                      entities={shell.inbox(server().id).entities}
                      connected={server().status === "connected" &&
                        server().harness === "connected"}
                      request={request()}
                      retention={shell.connection(server().id).attention}
                      onDismiss={() =>
                        shell.connection(server().id).attention.dismiss(
                          "form",
                          request().id,
                        )}
                      failureTarget={{
                        sidecarId: server().id,
                        ...(request().owner.kind === "location"
                          ? {
                            directory:
                              (request().owner as { directory: string })
                                .directory,
                          }
                          : {}),
                      }}
                      onReply={(answer) =>
                        shell.connection(server().id).rpc.call("form.reply", {
                          requestID: request().id,
                          answer,
                        }).then(() => {})}
                      onCancel={(message) =>
                        shell.connection(server().id).rpc.call("form.cancel", {
                          requestID: request().id,
                          ...(message === undefined ? {} : { message }),
                        }).then(() => {})}
                    />
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      );
    },
  });
}
export function registerFormTakeover(
  registry: SurfaceRegistry<TakeoverDefinition>,
): void {
  registry.register({
    id: "forms",
    capability: "forms",
    active: (session) => !!session.forms?.().length,
    component: () => {
      const session = useSessionPorts();
      return (
        <For
          each={session.forms?.().slice(0, 1) ?? []}
          keyed={(r) => r.id}
        >
          {(request) => {
            const target = () => {
              const owner = request().owner;
              const id = owner.kind === "session"
                ? owner.sessionID
                : session.sessionID();
              const entry = session.entry(id);
              return {
                ...session.failureTarget?.(),
                sessionID: id,
                directory: entry?.directory,
                label: entry?.title,
              };
            };
            return (
              <FormDock
                entities={session.entities?.()}
                connected={session.connected?.() ?? true}
                request={request()}
                retention={session.requests}
                onDismiss={session.requests && (() => {
                  session.requests!.dismiss("form", request().id);
                })}
                failureTarget={target()}
                onDirty={(value, text) => session.dirty("forms", value, text)}
                onReply={(answer) =>
                  session.rpc(
                    "form.reply",
                    { requestID: request().id, answer },
                    {
                      facts: { target: target() },
                    },
                  )
                    .then(() => {})}
                onCancel={(message) =>
                  session.rpc("form.cancel", {
                    requestID: request().id,
                    ...(message !== undefined ? { message } : {}),
                  }, { facts: { target: target() } }).then(() => {})}
              />
            );
          }}
        </For>
      );
    },
  });
}
export default function FormDock(
  props: {
    request: FormRequest;
    entities?: import("@otk/client").EntityStateStore;
    connected?: boolean;
    failureTarget?: import("@otk/protocol").FailureTarget;
    onReply(answer: FormAnswer): Promise<void>;
    onCancel(message?: string): Promise<void>;
    onDirty?(dirty: boolean, text?: string): void;
    onDismiss?(): void;
    retention?: import("@otk/client").RequestLifetimes;
  },
): SolidElement {
  const form = createForm(props.request, solidState, props.retention);
  const [collapsed, collapse] = createSignal(false),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal<FailureValue>(""),
    [attempted, attempt] = createSignal(false),
    [decline, setDecline] = createSignal(false),
    [message, setMessage] = createSignal("");
  let alive = true;
  const derived = () => form.derive();
  bindDirtyInput(() => ({
    dirty: Object.values(form.state.drafts).some((draft) => draft.touched),
    text: JSON.stringify(derived().answer),
  }), (dirty, text) => props.onDirty?.(dirty, text));
  onCleanup(() => {
    alive = false;
  });
  const send = async (cancel = false, feedback?: string) => {
    if (pending() || !alive || props.connected === false) return;
    attempt(true);
    if (!cancel && Object.keys(derived().issues).length) {
      form.review(false);
      return;
    }
    setPending(true);
    setError("");
    const settled = props.retention?.settlement("form", props.request.id);
    try {
      if (cancel) await props.onCancel(feedback);
      else await props.onReply(derived().answer);
      settled?.();
      forgetForm(props.request.id);
      if (alive) props.onDirty?.(false);
    } catch (cause) {
      if (alive) {
        setError(
          failureValue(cause, {
            actionLabel: "Sending form response",
            target: props.failureTarget,
          }),
        );
      }
    } finally {
      if (alive) setPending(false);
    }
  };
  const primary = createPrimaryAction({
    label: () => form.state.review ? "Send answers" : "Review answers",
    unavailable: () =>
      !alive
        ? "Form is no longer active"
        : props.connected === false
        ? "Reconnect to respond"
        : Object.values(derived().issues)[0],
    pending,
    pendingReason: "Sending response",
    run: () => {
      attempt(true);
      if (form.state.review) return send();
      form.review(true);
    },
  });
  const primaryState = bindPrimaryAction(primary);
  const answer = ownedAction("Answer form", () => primary.invoke(), {
    enabled: () => primaryState().available,
  });
  return (
    <section
      class="otk-question-dock otk-form-dock"
      aria-label="Pending form"
      data-form={props.request.id}
      data-form-owner={props.request.owner.kind}
      onKeyDown={(event) => {
        if (event.key === "Escape" && props.onDismiss) {
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss();
        }
      }}
    >
      <Takeover
        collapsed={collapsed()}
        title={
          <TakeoverHeader
            entities={props.entities}
            entityKey={props.request.owner.kind === "session"
              ? `session:${props.request.owner.sessionID}`
              : `project:${props.request.owner.directory}`}
            title={props.request.title}
            where={props.request.directory}
            collapsed={collapsed()}
            onCollapse={collapse}
          />
        }
        actions={() => (
          <div class="otk-question-actions">
            <PrimaryAction
              state={primaryState()}
              class="otk-primary otk-pill"
              onInvoke={() => void answer()}
            />
            <Show
              when={!pending()}
              fallback={
                <FeedbackStatus
                  feedback={{ kind: "pending", text: "Sending response..." }}
                />
              }
            >
              <Show when={form.state.review}>
                <button
                  type="button"
                  class="otk-pill"
                  onClick={() => form.review(false)}
                >
                  Edit answers
                </button>
              </Show>
              <button
                type="button"
                class="otk-pill"
                onClick={() => setDecline(!decline())}
              >
                Decline with feedback
              </button>
              <button
                type="button"
                class="otk-pill"
                onClick={() => void send(true)}
              >
                Cancel execution
              </button>
            </Show>
            <RequestDismiss onDismiss={props.onDismiss} />
          </div>
        )}
      >
        <Show
          when={!collapsed()}
          fallback={
            <p class="otk-question-peek">
              {derived().active.length} fields need a response
            </p>
          }
        >
          <div class="otk-form-fields">
            <Show
              when={!form.state.review && !pending()}
              fallback={
                <dl class="otk-form-review">
                  <For each={Object.entries(derived().answer)} keyed={false}>
                    {(entry) => (
                      <div>
                        <dt class="otk-control-label" title={entry()[0]}>
                          {props.request.fields.find((f) =>
                            f.key === entry()[0]
                          )?.title || entry()[0]}
                        </dt>
                        <dd>{JSON.stringify(entry()[1])}</dd>
                      </div>
                    )}
                  </For>
                </dl>
              }
            >
              <For each={derived().visible} keyed={(f) => f.key}>
                {(field) => (
                  <div
                    class="otk-form-field"
                    data-field={field().key}
                    data-kind={field().type}
                  >
                    <span
                      class="otk-control-label otk-form-label"
                      title={field().title || field().key}
                    >
                      {field().title || field().key}
                      {field().type !== "external" &&
                          (field() as { required?: boolean }).required
                        ? " (required)"
                        : ""}
                    </span>
                    <Show when={field().description}>
                      <p>{field().description}</p>
                    </Show>
                    <FormField
                      field={field()}
                      draft={form.state.drafts[field().key] ?? {}}
                      value={derived().answer[field().key]}
                      onValue={(value) => form.set(field().key, value)}
                      onText={(text) => form.text(field().key, text)}
                      onChoice={(value) => form.pick(field().key, value)}
                      onCustomText={(text) =>
                        form.customText(field().key, text)}
                      onAddCustom={() => form.addCustom(field().key)}
                    />
                    <Show
                      when={(attempted() ||
                        form.state.drafts[field().key]?.touched ||
                        (field() as { hidden?: boolean }).hidden) &&
                        derived().issues[field().key]}
                    >
                      <FeedbackStatus
                        feedback={errorFeedback(derived().issues[field().key], {
                          actionLabel: "Sending form response",
                          target: props.failureTarget,
                        })}
                      />
                    </Show>
                  </div>
                )}
              </For>
              <For each={derived().hidden} keyed={(f) => f.key}>
                {(field) => (
                  <div class="otk-form-hidden">
                    <span
                      class="otk-control-label"
                      title={field().title || field().key}
                    >
                      {field().title || field().key}:{" "}
                      {JSON.stringify(derived().answer[field().key])}
                    </span>
                    <button
                      type="button"
                      class="otk-pill"
                      onClick={() => form.reveal(field().key)}
                    >
                      Override value
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <Show when={decline() && !pending()}>
            <div class="otk-form-decline">
              <input
                aria-label="Feedback for the requester"
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
              />
              <Show when={message().trim()}>
                <button
                  type="button"
                  class="otk-pill"
                  onClick={() => void send(true, message())}
                >
                  Send feedback and decline
                </button>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={error()}>
          <FeedbackStatus feedback={errorFeedback(error())} />
        </Show>
      </Takeover>
    </section>
  );
}
