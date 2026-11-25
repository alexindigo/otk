// SPDX-License-Identifier: LGPL-3.0-only
import FeedbackStatus from "./FeedbackStatus.tsx";
import { bindFeedback } from "../state/feedback.ts";
import {
  createPrimaryAction,
  errorFeedback,
  type FailureValue,
  failureValue,
  requestIdle,
} from "@otk/client";
import PrimaryAction from "./PrimaryAction.tsx";
import { bindPrimaryAction } from "../state/primary-action.ts";
import "./PermissionDock.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import Takeover from "./surface/Takeover.tsx";
import type { DockRegistry } from "../registries/renderers.ts";
export function registerPermissionDock(docks: DockRegistry): void {
  docks.register({
    id: "permissions",
    capability: "permissions",
    render: (inputs) => inputs.permissions,
  });
}
import {
  createEffect,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type { PermissionRequest } from "@otk/protocol";
import type { PermissionReply } from "@otk/protocol";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { type SessionPorts, useSessionPorts } from "../registries/session.tsx";
import { oldestPermission } from "@otk/client";
import TakeoverHeader from "./TakeoverHeader.tsx";
import RequestDismiss from "./RequestDismiss.tsx";
import { bindDirtyInput } from "../state/dirty-input.ts";
import PermissionSummary from "./PermissionSummary.tsx";
import RequestAge from "./RequestAge.tsx";
import type {
  SurfaceRegistry,
  TakeoverDefinition,
} from "../registries/shell.ts";
export function registerPermissionTakeover(
  registry: SurfaceRegistry<TakeoverDefinition>,
): void {
  registry.register({
    id: "permissions",
    capability: "permissions",
    component: PermissionTakeover,
    active: (session) =>
      !!oldestPermission(
        visiblePermissions(session),
        session.sessionID(),
        session.entry,
      ),
  });
}
function visiblePermissions(session: SessionPorts) {
  return session.permissions().filter((request) =>
    session.permissionVisible?.(request) ?? true
  );
}
function PermissionTakeover(
  props: { notice?: () => import("solid-js").Element; focusNotice?(): void } =
    {},
) {
  const session = useSessionPorts(), { commands } = useCommandPorts();
  const request = () =>
    oldestPermission(
      visiblePermissions(session),
      session.sessionID(),
      session.entry,
    );
  return (
    <>
      <PermissionDock
        notice={props.notice}
        focusNotice={props.focusNotice}
        request={request()}
        activity={requestIdle(
          session.entry(request()?.sessionID ?? "")?.timeUpdated,
          Date.now(),
        )}
        where={request()
          ? `${request()!.kind} in ${
            session.location?.(request()!.sessionID) ??
              session.entry(request()!.sessionID)?.title ?? request()!.sessionID
          }`
          : undefined}
        childTitle={request()?.sessionID !== session.sessionID()
          ? session.entry(request()?.sessionID ?? "")?.title ||
            request()?.sessionID
          : undefined}
        onDirty={(value, input) => session.dirty("permissions", value, input)}
        onDismiss={session.requests && (() => {
          const current = request();
          if (!current) return;
          session.requests!.dismiss("permission", current.id);
        })}
        onReply={(input) => commands.run("permission.reply", input)}
      />
    </>
  );
}
function RequestDock(
  props: {
    request: PermissionRequest;
    activity?: ReturnType<typeof requestIdle>;
    notice?: () => import("solid-js").Element;
    focusNotice?(): void;
    childTitle?: string;
    where?: string;
    onReply(input: PermissionReply): Promise<void>;
    onDismiss?(): void;
    onDirty(value: boolean, input?: string): void;
  },
) {
  const session = useSessionPorts();
  const feedback = session?.feedback;
  const operation = bindFeedback(() => feedback);
  const [mode, setMode] = createSignal<"normal" | "always" | "reject">(
    "normal",
  );
  const [message, changeMessage] = createSignal(
      (session?.requests?.draft("permission", props.request.id) as
        | string
        | undefined) ?? "",
    ),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal<FailureValue>("");
  let active = true, card!: HTMLElement, pendingStatus!: HTMLDivElement;
  bindDirtyInput(
    () => ({ dirty: !!message(), text: message() }),
    (dirty, text) => props.onDirty(dirty, text),
  );
  const setMessage = (value: string) => {
    changeMessage(value);
    session?.requests?.draft("permission", props.request.id, value);
  };
  createEffect(
    () => ({ pending: pending(), feedback: operation() }),
    (value) => {
      if (value.pending) {
        onSettled(() => {
          if (props.focusNotice && value.feedback) props.focusNotice();
          else pendingStatus?.focus();
        });
      }
    },
  );
  createEffect(mode, (_value, previous) => {
    if (previous !== undefined) {
      card.querySelector<HTMLButtonElement>(".otk-permission-actions button")
        ?.focus();
    }
  });
  onSettled(() => () => {
    active = false;
  });
  const answer = async (reply: PermissionReply["reply"]) => {
    if (pending() || !primary.permitted()) return;
    const input: PermissionReply = {
      requestID: props.request.id,
      sessionID: props.request.sessionID,
      reply,
      message: reply === "reject" ? message().trim() || undefined : undefined,
    };
    setPending(true);
    feedback?.clear();
    setError("");
    const settled = session?.requests?.settlement(
      "permission",
      props.request.id,
    );
    try {
      await props.onReply(input);
      settled?.();
      if (active) props.onDirty(false);
    } catch (error) {
      if (feedback) feedback.fail(error);
      else if (active) {
        setError(
          failureValue(error, { actionLabel: "Sending permission response" }),
        );
      }
    } finally {
      if (active) setPending(false);
    }
  };
  const primary = createPrimaryAction<PermissionReply["reply"]>({
    label: () =>
      mode() === "always"
        ? "Confirm allow always"
        : mode() === "reject"
        ? "Reject request"
        : "Allow once",
    unavailable: () =>
      !active
        ? "Permission is no longer active"
        : session?.connected?.() === false
        ? "Reconnect to respond"
        : undefined,
    pending,
    pendingReason: "Sending response",
    run: answer,
  });
  const primaryState = bindPrimaryAction(primary);
  const ports = useCommandPorts();
  const once = ownedCommand(ports, {
    id: "permission.once",
    title: "Allow permission once",
    category: "Attention",
    enabled: () => primaryState().available,
    run: () => primary.invoke("once"),
  });
  const always = ownedCommand(ports, {
    id: "permission.always",
    title: "Review future permission grant",
    category: "Attention",
    enabled: () => !pending(),
    run: () => setMode("always"),
  });
  const reject = ownedCommand(ports, {
    id: "permission.reject",
    title: "Review permission rejection",
    category: "Attention",
    enabled: () => !pending(),
    run: () => setMode("reject"),
  });
  // Fixed widget keys, active only on this card's non-text controls in normal mode.
  const shortcuts = {
    once: { key: "1", run: once },
    always: { key: "2", run: always },
    reject: { key: "3", run: reject },
  };
  const answerCommand = ownedCommand(ports, {
    id: "permission.answer",
    title: "Answer permission",
    category: "Attention",
    arguments: { type: "string", enum: ["once", "always", "reject"] },
    enabled: () => primaryState().available,
    run: (_ctx, reply: PermissionReply["reply"]) => primary.invoke(reply),
  });
  const close = ownedCommand(ports, {
    id: "permission.close",
    title: "Close permission confirmation",
    category: "Attention",
    run: () => mode() !== "normal" ? setMode("normal") : props.onDismiss?.(),
  });
  onSettled(() =>
    ports.keyboard?.layer(
      "permission.close",
      () => card.contains(document.activeElement),
      20,
    )
  );
  return (
    <section
      class="otk-permission-dock"
      tabindex="-1"
      ref={(element) => {
        card = element;
      }}
      aria-label="Pending permission"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void close();
          return;
        }
        if (
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement || pending() ||
          mode() !== "normal"
        ) return;
        const shortcut = Object.values(shortcuts).find((item) =>
          item.key === event.key
        );
        if (shortcut) {
          event.preventDefault();
          void shortcut.run();
        }
      }}
    >
      <Takeover
        notice={props.notice}
        title={
          <TakeoverHeader
            entityKey={`session:${props.request.sessionID}`}
            title={props.request.detail.kind === "bash"
              ? "Run this command?"
              : "Allow this action?"}
            detail={props.request.title}
            where={props.where ?? props.request.kind}
            childTitle={props.childTitle}
          />
        }
        actions={() => (
          <div class="otk-permission-actions">
            <PrimaryAction
              state={primaryState()}
              // Rejection keeps its native form: the primary submits the
              // rejection message form; the form's submit handler answers.
              type={mode() === "reject" ? "submit" : "button"}
              form={mode() === "reject"
                ? `otk-reject-${props.request.id}`
                : undefined}
              onInvoke={() =>
                void answerCommand(
                  mode() === "always"
                    ? "always"
                    : mode() === "reject"
                    ? "reject"
                    : "once",
                )}
              class="otk-primary otk-pill"
              title={mode() === "normal"
                ? `Allow once (${shortcuts.once.key} when focused)`
                : primaryState().label}
              description={props.activity?.resume}
            />
            <Show when={pending() && !(props.focusNotice && operation())}>
              <FeedbackStatus
                ref={(element) => pendingStatus = element}
                focusable
                feedback={{ kind: "pending", text: "Sending response..." }}
              />
            </Show>
            <Switch>
              <Match when={mode() === "normal"}>
                <button
                  type="button"
                  hidden={pending()}
                  onClick={() => void always()}
                  class="otk-pill"
                  title={`Review future grant (${shortcuts.always.key} when focused)`}
                >
                  Always allow
                </button>
                <button
                  type="button"
                  hidden={pending()}
                  onClick={() => void reject()}
                  class="otk-pill"
                  title={`Reject (${shortcuts.reject.key} when focused)`}
                >
                  Reject
                </button>
                <input
                  class="otk-rejection-reason"
                  aria-label="Reason for rejecting (optional)"
                  placeholder="Reason for rejecting (optional)"
                  value={message()}
                  readonly={pending()}
                  onInput={(event) => {
                    setMessage(event.currentTarget.value);
                  }}
                />
              </Match>
              <Match when={mode() === "always"}>
                <button
                  type="button"
                  hidden={pending()}
                  onClick={() => void close()}
                  class="otk-pill"
                >
                  Cancel
                </button>
              </Match>
              <Match when={mode() === "reject"}>
                <button
                  type="button"
                  hidden={pending()}
                  onClick={() => void close()}
                  class="otk-pill"
                >
                  Cancel
                </button>
              </Match>
            </Switch>
            <RequestDismiss onDismiss={props.onDismiss} />
          </div>
        )}
      >
        <RequestAge value={props.activity?.lead ? props.activity : undefined} />
        <PermissionSummary request={props.request} />
        <Show when={error()}>
          <FeedbackStatus feedback={errorFeedback(error())} />
        </Show>
        <Show when={mode() === "always"}>
          <div class="otk-permission-confirm">
            <p>Allow these patterns for future requests?</p>
            <ul>
              <For each={props.request.alwaysPatterns} keyed={false}>
                {(pattern) => <li>{pattern()}</li>}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={mode() === "reject"}>
          <form
            id={`otk-reject-${props.request.id}`}
            class="otk-permission-reject"
            onSubmit={(event) => {
              event.preventDefault();
              void answerCommand("reject");
            }}
          >
            <label>
              Optional rejection message<ScrollRegion
                as="textarea"
                name="rejection"
                value={message()}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setMessage(value);
                }}
              />
            </label>
          </form>
        </Show>
      </Takeover>
    </section>
  );
}
export default function PermissionDock(
  props: {
    request?: PermissionRequest;
    activity?: ReturnType<typeof requestIdle>;
    notice?: () => import("solid-js").Element;
    focusNotice?(): void;
    childTitle?: string;
    where?: string;
    onReply(input: PermissionReply): Promise<void>;
    onDismiss?(): void;
    onDirty(value: boolean, input?: string): void;
  },
): import("solid-js").Element {
  return (
    <For
      each={props.request ? [props.request] : []}
      keyed={(request) => request.id}
    >
      {(request) => (
        <RequestDock
          notice={props.notice}
          focusNotice={props.focusNotice}
          request={request()}
          activity={props.activity}
          childTitle={props.childTitle}
          where={props.where}
          onReply={(input) => props.onReply(input)}
          onDismiss={props.onDismiss}
          onDirty={(value, input) => props.onDirty(value, input)}
        />
      )}
    </For>
  );
}
