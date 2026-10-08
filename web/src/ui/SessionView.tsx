// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  deep,
  type Element,
  For,
  onSettled,
  Show,
} from "solid-js";
import type {
  ContentSession,
  Message as OtkMessage,
} from "../../../protocol/content.ts";
import Message from "./Message.tsx";
import Prompt from "./Prompt.tsx";
import type { Preferences } from "../../../protocol/prefs.ts";
export default function SessionView(props: {
  info?: ContentSession;
  label: string;
  messages: OtkMessage[];
  loading: boolean;
  paging: boolean;
  exhausted: boolean;
  error?: string;
  draft: string;
  connected: boolean;
  permissionDock?: Element;
  displayMenu?: Element;
  prefs: Preferences;
  onOlder(): Promise<void>;
  onRetry(): Promise<void>;
  onDraft(value: string): void;
  onPrompt(text: string): Promise<void>;
  onAbort(): Promise<void>;
}) {
  let list!: HTMLDivElement,
    atBottom = true,
    previousHeight = 0,
    paging = false;
  const scroll = () => {
    atBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 24;
    if (
      list.scrollTop < 24 && !props.loading && !props.paging && !props.exhausted
    ) {
      paging = true;
      previousHeight = list.scrollHeight;
      void props.onOlder();
    }
  };
  createEffect(
    () => ({
      messages: deep(props.messages),
      loading: props.loading,
      paging: props.paging,
    }),
    (value) => {
      if (!list) return;
      if (paging && !value.paging) {
        list.scrollTop += list.scrollHeight - previousHeight;
        paging = false;
      } else if (atBottom && !paging) list.scrollTop = list.scrollHeight;
    },
  );
  onSettled(() => {
    list.scrollTop = list.scrollHeight;
    list.addEventListener("scroll", scroll);
    return () => list.removeEventListener("scroll", scroll);
  });
  return (
    <section class="otk-session-view" aria-label="Session">
      <header class="otk-view-header">
        <div>
          <h1>{props.info?.title || "Loading session…"}</h1>
          <p title={props.info?.directory}>
            {props.info?.directory} · {props.label}
          </p>
        </div>
        {props.displayMenu}
      </header>
      <div
        class={["otk-messages", {
          "otk-scrollbar-hidden": !props.prefs.scrollbar,
        }]}
        ref={(element) => {
          list = element;
        }}
      >
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
        <Show when={props.loading}>
          <p class="otk-muted">Loading messages…</p>
        </Show>
        <Show when={props.error}>
          <p role="alert" class="otk-error">{props.error}</p>
          <button type="button" onClick={() => void props.onRetry()}>
            Retry messages
          </button>
        </Show>
        <For each={props.messages} keyed={(message) => message.id}>
          {(message) => <Message message={message()} prefs={props.prefs} />}
        </For>
        <Show when={!props.loading && !props.messages.length && !props.error}>
          <p class="otk-muted otk-empty">Start a conversation below.</p>
        </Show>
      </div>
      {props.permissionDock}
      <Prompt
        value={props.draft}
        connected={props.connected}
        onChange={(value) => props.onDraft(value)}
        onSubmit={(text) => props.onPrompt(text)}
        onAbort={() => props.onAbort()}
      />
    </section>
  );
}
