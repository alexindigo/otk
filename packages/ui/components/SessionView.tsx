// SPDX-License-Identifier: LGPL-3.0-only
import "./SessionView.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  type Element,
  For,
  onSettled,
  Show,
} from "solid-js";
import type {
  ContentSession,
  Message as OtkMessage,
  ModelCatalog,
  PermissionRequest,
  RevertInfo,
  SessionUsage,
} from "@otk/protocol";
import Message from "./Message.tsx";
import Prompt from "./Prompt.tsx";
import ComposerTakeovers from "./ComposerTakeovers.tsx";
import type { Preferences } from "@otk/protocol";
import SubagentBar from "./SubagentBar.tsx";
import RevertBanner from "./RevertBanner.tsx";
import SessionError from "./SessionError.tsx";
import type { SessionErrorState } from "@otk/protocol";
import { queuedMessages, replyMessages, turnUsage } from "@otk/client";
import { followViewport } from "./viewport.ts";
import { highlightingScope } from "../highlight/client.ts";
import type { Draft, DraftChange } from "./prompt/model.ts";
import type { PromptProps } from "../registries/prompt.ts";
import { ownedAction } from "../keyboard/context.tsx";
export default function SessionView(props: {
  info?: ContentSession;
  label: string;
  messages: OtkMessage[];
  catalog?: ModelCatalog;
  usage?: SessionUsage;
  loading: boolean;
  paging: boolean;
  exhausted: boolean;
  error?: string;
  sessionError?: string;
  errorState?: SessionErrorState;
  draft: Draft;
  connected: boolean;
  displayMenu?: Element;
  prefs: Preferences;
  permissions: PermissionRequest[];
  siblings: ContentSession[];
  onOpenChild(id: string): void;
  child: boolean;
  revert: RevertInfo | null;
  busy: boolean;
  retryState?: { attempt: number; message: string; next: number };
  onOlder(): Promise<void>;
  onRetry(): Promise<void>;
  onDraft(value: DraftChange): Draft;
  onPrompt: PromptProps["onSubmit"];
  onAbort(): Promise<void>;
}): Element {
  const writeDraft = props.onDraft;
  const queued = () => queuedMessages(props.messages, props.busy);
  const messages = createMemo(() => replyMessages(props.messages));
  const [now, setNow] = createSignal(Date.now());
  const older = ownedAction("session.page", () => props.onOlder());
  const retry = ownedAction("session.refetch", () => props.onRetry());
  const [paneWidth, setPaneWidth] = createSignal(0);
  let view!: HTMLElement;
  let list!: HTMLDivElement, flow!: HTMLDivElement;
  let following: ReturnType<typeof followViewport> | undefined;
  let releaseHighlighting: (() => void) | undefined;
  createEffect(() => props.busy, (busy) => {
    if (busy) releaseHighlighting ||= highlightingScope();
    else {
      releaseHighlighting?.();
      releaseHighlighting = undefined;
    }
  });
  createEffect(
    () => ({
      paging: props.paging,
      id: props.info?.id,
    }),
    (value, previous) => {
      if (value.id && value.id !== previous?.id) following?.reset();
      following?.update(value.paging);
    },
  );
  onSettled(() => {
    const clock = setInterval(() => {
      if (props.retryState) setNow(Date.now());
    }, 1000);
    const observer = new ResizeObserver((entries) =>
      setPaneWidth(entries[0].contentRect.width)
    );
    observer.observe(view);
    following = followViewport(list, flow, () => {
      if (!props.loading && !props.paging && !props.exhausted) {
        void props.onOlder();
      }
    });
    return () => {
      clearInterval(clock);
      observer.disconnect();
      following?.dispose();
      following = undefined;
      releaseHighlighting?.();
      releaseHighlighting = undefined;
    };
  });
  return (
    <section
      class="otk-session-view"
      aria-label="Session"
      ref={(element) => {
        view = element;
      }}
    >
      {props.displayMenu}
      <Show when={props.info?.parentID}>
        <SubagentBar
          info={props.info!}
          siblings={props.siblings}
          onOpen={props.onOpenChild}
        />
      </Show>
      <div
        class={["otk-messages", {
          "otk-scrollbar-hidden": !props.prefs.scrollbar,
        }]}
        ref={(element) => {
          list = element;
        }}
      >
        <Show when={props.loading}>
          <p class="otk-muted">Loading messages…</p>
        </Show>
        <div
          class="otk-message-flow"
          ref={(element) => {
            flow = element;
          }}
        >
          <Show when={props.revert}>
            {(revert) => <RevertBanner revert={revert()} />}
          </Show>
          <Show when={!props.exhausted && props.messages.length}>
            <button
              type="button"
              class="otk-load-older"
              disabled={props.paging || props.loading}
              onClick={() => void older()}
            >
              {props.paging ? "Loading…" : "Load older messages"}
            </button>
          </Show>
          <Show when={props.error}>
            <p role="alert" class="otk-error">{props.error}</p>
            <button type="button" onClick={() => void retry()}>
              Retry messages
            </button>
          </Show>
          <SessionError state={props.errorState} error={props.sessionError} />
          <Show when={props.retryState}>
            {(retry) => (
              <div class="otk-retry-banner" role="status">
                <strong>Retrying · attempt {retry().attempt}</strong>
                <p>{retry().message}</p>
                <span>
                  Next attempt in{" "}
                  {Math.max(0, Math.ceil((retry().next - now()) / 1000))}s
                </span>
              </div>
            )}
          </Show>
          <For each={messages()} keyed={(message) => message.id}>
            {(message) => (
              <Message
                message={message()}
                usage={turnUsage(props.usage, message(), props.catalog)}
                prefs={props.prefs}
                directory={props.info?.directory}
                permissions={props.permissions}
                paneWidth={paneWidth()}
                onOpenChild={props.onOpenChild}
                queued={queued().has(message().id)}
              />
            )}
          </For>
          <Show
            when={!props.loading && !props.messages.length && !props.error &&
              !props.sessionError}
          >
            <p class="otk-muted otk-empty">Start a conversation below.</p>
          </Show>
        </div>
      </div>
      <Show when={!props.child}>
        <ComposerTakeovers>
          {(active) => (
            <div hidden={active()} inert={active()}>
              <Prompt
                suspended={active()}
                context={props.messages.findLast((message) =>
                  message.role === "user"
                ) as import("@otk/protocol").UserMessage | undefined}
                busy={props.busy}
                value={props.draft}
                connected={props.connected}
                onChange={writeDraft}
                onSubmit={(parts, mode, selection) =>
                  props.onPrompt(parts, mode, selection)}
                onAbort={() => props.onAbort()}
              />
            </div>
          )}
        </ComposerTakeovers>
      </Show>
    </section>
  );
}
