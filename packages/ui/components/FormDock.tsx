// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  type Element as SolidElement,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { createForm, failureText, forgetForm } from "@otk/client";
import type { FormAnswer, FormRequest } from "@otk/protocol";
import { solidState } from "../state/binding.ts";
import Takeover from "./surface/Takeover.tsx";
import TakeoverHeader from "./TakeoverHeader.tsx";
import FeedbackStatus from "./FeedbackStatus.tsx";
import FormField from "./FormField.tsx";
import { useShellPorts } from "../shell/context.tsx";
import type {
  SurfaceRegistry,
  TakeoverDefinition,
} from "../registries/shell.ts";
import { useSessionPorts } from "../registries/session.tsx";
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
              <For
                each={shell.forms?.(server().id).filter((f) =>
                  f.owner.kind === "location"
                ).slice(0, 1) ?? []}
                keyed={(f) => f.id}
              >
                {(request) => (
                  <FormDock
                    request={request()}
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
          {(request) => (
            <FormDock
              request={request()}
              onDirty={(value, text) => session.dirty("forms", value, text)}
              onReply={(answer) =>
                session.rpc("form.reply", { requestID: request().id, answer })
                  .then(() => {})}
              onCancel={(message) =>
                session.rpc("form.cancel", {
                  requestID: request().id,
                  ...(message !== undefined ? { message } : {}),
                }).then(() => {})}
            />
          )}
        </For>
      );
    },
  });
}
export default function FormDock(
  props: {
    request: FormRequest;
    onReply(answer: FormAnswer): Promise<void>;
    onCancel(message?: string): Promise<void>;
    onDirty?(dirty: boolean, text?: string): void;
  },
): SolidElement {
  const form = createForm(props.request, solidState);
  const [collapsed, collapse] = createSignal(false),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(""),
    [attempted, attempt] = createSignal(false),
    [decline, setDecline] = createSignal(false),
    [message, setMessage] = createSignal("");
  let alive = true;
  const derived = () => form.derive();
  onCleanup(() => {
    alive = false;
  });
  createEffect(() => JSON.stringify(form.state.drafts), () => {
    if (Object.values(form.state.drafts).some((d) => d.touched)) {
      props.onDirty?.(true, JSON.stringify(derived().answer));
    }
  });
  const send = async (cancel = false, feedback?: string) => {
    if (pending()) return;
    attempt(true);
    if (!cancel && Object.keys(derived().issues).length) {
      form.review(false);
      return;
    }
    setPending(true);
    setError("");
    try {
      if (cancel) await props.onCancel(feedback);
      else await props.onReply(derived().answer);
      forgetForm(props.request.id);
      props.onDirty?.(false);
    } catch (cause) {
      if (alive) setError(failureText(cause));
    } finally {
      if (alive) setPending(false);
    }
  };
  return (
    <section
      class="otk-question-dock otk-form-dock"
      aria-label="Pending form"
      data-form={props.request.id}
      data-form-owner={props.request.owner.kind}
    >
      <Takeover
        collapsed={collapsed()}
        title={
          <TakeoverHeader
            title={props.request.title}
            where={props.request.directory}
            collapsed={collapsed()}
            onCollapse={collapse}
          />
        }
        actions={
          <div class="otk-question-actions">
            <Show
              when={!pending()}
              fallback={
                <FeedbackStatus
                  feedback={{ kind: "pending", text: "Sending response..." }}
                />
              }
            >
              <Show when={!form.state.review}>
                <button
                  type="button"
                  class="otk-primary otk-pill"
                  onClick={() => {
                    attempt(true);
                    if (!Object.keys(derived().issues).length) {
                      form.review(
                        true,
                      );
                    }
                  }}
                >
                  Review answers
                </button>
              </Show>
              <Show when={form.state.review}>
                <button
                  type="button"
                  class="otk-pill"
                  onClick={() => form.review(false)}
                >
                  Edit answers
                </button>
                <button
                  type="button"
                  class="otk-primary otk-pill"
                  onClick={() => void send()}
                >
                  Send answers
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
          </div>
        }
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
                        feedback={{
                          kind: "error",
                          text: derived().issues[field().key],
                        }}
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
          <FeedbackStatus feedback={{ kind: "error", text: error() }} />
        </Show>
      </Takeover>
    </section>
  );
}
