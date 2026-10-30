// SPDX-License-Identifier: LGPL-3.0-only
import "./Timeline.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import type { Selection, TimelinePrompt } from "@otk/client";
import { failureText } from "@otk/client";
import { contextTarget } from "./context-target.ts";
import MessageActions from "./MessageActions.tsx";
import ListRow from "./ListRow.tsx";
import { EmptyState } from "./View.tsx";
import VirtualList from "./VirtualList.tsx";

function PromptRow(props: {
  prompt: TimelinePrompt;
  target: import("../features/transcript-context.tsx").ContentTarget;
  selected: boolean;
  onReveal(): void;
}) {
  let row!: HTMLElement;
  const [revealed, setRevealed] = createSignal(false);
  return (
    <li>
      <ListRow
        as="div"
        ref={[(element) => {
          row = element;
        }, contextTarget(() => ({ kind: "prompt", data: props.target }))]}
        selected={props.selected}
        class={`otk-timeline-row${revealed() ? " is-revealed" : ""}`}
        attributes={{ "data-timeline-prompt": props.prompt.id }}
        labelClass="otk-timeline-preview"
        labelTitle={props.target.text}
        actionClass="otk-timeline-reveal"
        activate={props.onReveal}
        trailing={
          <span class="otk-timeline-trailing">
            <time
              class="otk-timeline-clock"
              datetime={new Date(props.prompt.time).toISOString()}
            >
              {new Date(props.prompt.time).toLocaleTimeString()}
            </time>
            <MessageActions
              class="otk-timeline-actions"
              kind="prompt"
              target={props.target}
              revealed={revealed() || props.selected}
              region={() => row}
              onReveal={setRevealed}
            />
          </span>
        }
      >
        {props.target.text || "Prompt"}
        <Show when={props.prompt.queued}>
          {" "}
          <span class="otk-timeline-queued">Queued</span>
        </Show>
      </ListRow>
    </li>
  );
}

/** Data and callbacks only; the selected transcript remains owned by the shell. */
export default function Timeline(props: {
  session?: Selection;
  prompts: TimelinePrompt[];
  exhausted: boolean;
  paging: boolean;
  directory?: string;
  preview(prompt: TimelinePrompt): string;
  onOlder(): Promise<void>;
  onReveal(messageID: string): Promise<void>;
}): import("solid-js").Element {
  const [selected, setSelected] = createSignal("");
  const [error, setError] = createSignal("");
  let operation = 0;
  onCleanup(() => {
    operation++;
  });
  const prompts = createMemo(() =>
    new Map(props.prompts.map((prompt) => [prompt.id, prompt]))
  );
  createEffect(() => props.session, () => {
    operation++;
    setSelected("");
    setError("");
  });
  const perform = async (action: () => Promise<void>) => {
    const request = ++operation;
    const session = props.session;
    setError("");
    try {
      await action();
    } catch (error) {
      if (session === props.session && request === operation) {
        setError(failureText(error));
      }
    }
  };
  return (
    <section
      class="otk-timeline"
      aria-label="Timeline prompts"
      data-prompt-count={props.prompts.length}
    >
      <Show
        when={props.session}
        fallback={<EmptyState>Open a session to see its prompts.</EmptyState>}
      >
        <Show when={!props.exhausted}>
          <Show
            when={!props.paging}
            fallback={<p class="otk-muted" role="status">Loading prompts…</p>}
          >
            <button
              type="button"
              class="otk-timeline-older"
              onClick={() => void perform(props.onOlder)}
            >
              Load earlier prompts
            </button>
          </Show>
        </Show>
        <Show when={!props.prompts.length && !props.paging}>
          <EmptyState>No prompts yet.</EmptyState>
        </Show>
        <VirtualList
          keys={props.prompts.map((prompt) => prompt.id)}
          class="otk-timeline-list"
          label="Acquired prompts"
          samples={[{ role: "prompt", class: "otk-list-row" }]}
          role={() => "prompt"}
          overscan={0}
          retainExcluded={false}
          render={(key) => (
            <Show when={prompts().get(key)}>
              {(prompt) => {
                return (
                  <PromptRow
                    prompt={prompt()}
                    target={{
                      ...props.session,
                      messageID: prompt().id,
                      directory: props.directory,
                      text: props.preview(prompt()),
                      queued: prompt().queued,
                    }}
                    selected={selected() === prompt().id}
                    onReveal={() =>
                      void perform(async () => {
                        await props.onReveal(prompt().id);
                        setSelected(prompt().id);
                      })}
                  />
                );
              }}
            </Show>
          )}
        />
      </Show>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
    </section>
  );
}
