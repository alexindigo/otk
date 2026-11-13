// SPDX-License-Identifier: LGPL-3.0-only
import FeedbackStatus from "./FeedbackStatus.tsx";
import { bindFeedback } from "../state/feedback.ts";
import { failureText, requestIdle } from "@otk/client";
import "./PermissionDock.css" with { type: "text" };
import { scrollRegion } from "./ScrollRegion.tsx";
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
function waitingPermissions(session: SessionPorts) {
  return session.approvals
    ? session.approvals.attention(session.connected?.() ?? false).permissions(
      session.permissions(),
    )
    : session.permissions();
}
function visiblePermissions(session: SessionPorts) {
  return waitingPermissions(session).filter((request) =>
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
  const automatic = () =>
    session.permissions().length - waitingPermissions(session).length;
  return (
    <>
      <Show when={automatic() > 0 && !request()}>
        <p class="otk-auto-approving" role="status">Auto-approving…</p>
      </Show>
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
    onDirty(value: boolean, input?: string): void;
  },
) {
  const feedback = useSessionPorts()?.feedback;
  const operation = bindFeedback(() => feedback);
  const [mode, setMode] = createSignal<"normal" | "always" | "reject">(
    "normal",
  );
  const [message, setMessage] = createSignal(""),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  let active = true, card!: HTMLElement, pendingStatus!: HTMLDivElement;
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
    if (pending()) return;
    const input: PermissionReply = {
      requestID: props.request.id,
      sessionID: props.request.sessionID,
      reply,
      message: reply === "reject" ? message().trim() || undefined : undefined,
    };
    setPending(true);
    feedback?.clear();
    setError("");
    try {
      await props.onReply(input);
      props.onDirty(false);
    } catch (error) {
      if (feedback) feedback.fail(error);
      else if (active) setError(failureText(error));
    } finally {
      if (active) setPending(false);
    }
  };
  const ports = useCommandPorts();
  const once = ownedCommand(ports, {
    id: "permission.once",
    title: "Allow permission once",
    category: "Attention",
    enabled: () => !pending(),
    run: () => answer("once"),
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
    run: (_ctx, reply: PermissionReply["reply"]) => answer(reply),
  });
  const close = ownedCommand(ports, {
    id: "permission.close",
    title: "Close permission confirmation",
    category: "Attention",
    run: () => setMode("normal"),
  });
  onSettled(() =>
    ports.keyboard?.layer("permission.close", () => mode() !== "normal", 20)
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
        if (event.key === "Escape" && mode() !== "normal") {
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
            title={props.request.detail.kind === "bash"
              ? "Run this command?"
              : "Allow this action?"}
            detail={props.request.title}
            where={props.where ?? props.request.kind}
            childTitle={props.childTitle}
          />
        }
        actions={
          <>
            <Show when={pending() && !(props.focusNotice && operation())}>
              <FeedbackStatus
                ref={(element) => pendingStatus = element}
                focusable
                feedback={{ kind: "pending", text: "Sending response…" }}
              />
            </Show>
            <Switch>
              <Match when={mode() === "normal"}>
                <div class="otk-permission-actions">
                  <button
                    type="button"
                    hidden={pending()}
                    onClick={() => void once()}
                    class="otk-primary otk-pill"
                    title={`Allow once (${shortcuts.once.key} when focused)`}
                    aria-description={props.activity?.resume}
                  >
                    Allow once
                  </button>
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
                      props.onDirty(
                        !!event.currentTarget.value,
                        event.currentTarget.value,
                      );
                    }}
                  />
                </div>
              </Match>
              <Match when={mode() === "always"}>
                <div class="otk-permission-actions">
                  <button
                    type="button"
                    hidden={pending()}
                    onClick={() => void answerCommand("always")}
                    class="otk-primary otk-pill"
                  >
                    Confirm allow always
                  </button>
                  <button
                    type="button"
                    hidden={pending()}
                    onClick={() => void close()}
                    class="otk-pill"
                  >
                    Cancel
                  </button>
                </div>
              </Match>
              <Match when={mode() === "reject"}>
                <div class="otk-permission-actions">
                  <button
                    type="submit"
                    form={`otk-reject-${props.request.id}`}
                    class="otk-pill"
                    hidden={pending()}
                  >
                    Reject request
                  </button>
                  <button
                    type="button"
                    hidden={pending()}
                    onClick={() => void close()}
                    class="otk-pill"
                  >
                    Cancel
                  </button>
                </div>
              </Match>
            </Switch>
          </>
        }
      >
        <Show when={props.activity}>
          {(activity) => <RequestAge label={activity().label} />}
        </Show>
        <PermissionSummary request={props.request} />
        <Show when={error()}>
          <FeedbackStatus feedback={{ kind: "error", text: error() }} />
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
              Optional rejection message<textarea
                class={scrollRegion()}
                name="rejection"
                value={message()}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setMessage(value);
                  props.onDirty(!!value, value);
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
          onDirty={(value, input) => props.onDirty(value, input)}
        />
      )}
    </For>
  );
}
