// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  type Element,
  For,
  onSettled,
  Show,
} from "solid-js";
import type {
  ContentSession,
  Message as OtkMessage,
  PermissionRequest,
  RevertInfo,
} from "../../../protocol/content.ts";
import Message from "./Message.tsx";
import Prompt from "./Prompt.tsx";
import type { Preferences } from "../../../protocol/prefs.ts";
import SubagentBar from "./SubagentBar.tsx";
import RevertBanner from "./RevertBanner.tsx";
import { queuedMessages } from "../state/messages.ts";
import { followViewport } from "./viewport.ts";
import { highlightingScope } from "../highlight/client.ts";
import type { Draft, DraftChange } from "./prompt/model.ts";
import type { PromptPart } from "../../../protocol/rpc.ts";
export default function SessionView(props: {
  info?: ContentSession;
  label: string;
  messages: OtkMessage[];
  loading: boolean;
  paging: boolean;
  exhausted: boolean;
  error?: string;
  draft: Draft;
  connected: boolean;
  permissionDock?: Element;
  displayMenu?: Element;
  prefs: Preferences;
  permissions: PermissionRequest[];
  siblings: ContentSession[];
  onOpenChild(id: string): void;
  child: boolean;
  revert: RevertInfo | null;
  busy: boolean;
  onOlder(): Promise<void>;
  onRetry(): Promise<void>;
  onDraft(value: DraftChange): Draft;
  onPrompt(parts: PromptPart[]): Promise<void>;
  onFind(query: string): Promise<string[]>;
  onAbort(): Promise<void>;
}) {
  const queued = () => queuedMessages(props.messages, props.busy);
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
      <header class="otk-view-header">
        <div>
          <h1>{props.info?.title || "Loading session…"}</h1>
          <p title={props.info?.directory}>
            {props.info?.directory} · {props.label}
          </p>
        </div>
        {props.displayMenu}
      </header>
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
              onClick={() => void props.onOlder()}
            >
              {props.paging ? "Loading…" : "Load older messages"}
            </button>
          </Show>
          <Show when={props.error}>
            <p role="alert" class="otk-error">{props.error}</p>
            <button type="button" onClick={() => void props.onRetry()}>
              Retry messages
            </button>
          </Show>
          <For each={props.messages} keyed={(message) => message.id}>
            {(message) => (
              <Message
                message={message()}
                prefs={props.prefs}
                directory={props.info?.directory}
                permissions={props.permissions}
                paneWidth={paneWidth()}
                onOpenChild={props.onOpenChild}
                queued={queued().has(message().id)}
              />
            )}
          </For>
          <Show when={!props.loading && !props.messages.length && !props.error}>
            <p class="otk-muted otk-empty">Start a conversation below.</p>
          </Show>
        </div>
      </div>
      <Show when={!props.child}>
        {props.permissionDock}
        <Prompt
          value={props.draft}
          connected={props.connected}
          pasteSummary={props.prefs.pasteSummary}
          onChange={(value) => props.onDraft(value)}
          onSubmit={(text) => props.onPrompt(text)}
          onFind={props.onFind}
          onAbort={() => props.onAbort()}
        />
      </Show>
    </section>
  );
}
