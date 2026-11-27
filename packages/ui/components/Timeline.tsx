// SPDX-License-Identifier: LGPL-3.0-only
import "./Timeline.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import type { CollectionState, Selection, TimelinePrompt } from "@otk/client";
import { errorFeedback, type FailureValue, failureValue } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { contextTarget } from "./context-target.ts";
import MessageFooter from "./MessageFooter.tsx";
import SidebarRow from "./SidebarRow.tsx";
import { EmptyState } from "./View.tsx";
import ProgressStatus from "./ProgressStatus.tsx";
import VirtualList from "./VirtualList.tsx";
import ChromeMeta, { MetaItem } from "./ChromeMeta.tsx";

function PromptRow(props: {
  prompt: TimelinePrompt;
  target: import("../features/transcript-context.tsx").ContentTarget;
  selected: boolean;
  onReveal(): void;
}) {
  const ref = contextTarget(() => ({ kind: "prompt", data: props.target }));
  return (
    <li>
      <SidebarRow
        flat
        frame={{
          selected: props.selected,
          class: "otk-timeline-row",
          ref,
          attributes: { "data-timeline-prompt": props.prompt.id },
        }}
        action={{
          class: "otk-timeline-reveal",
          title: props.target.text,
          onClick: props.onReveal,
        }}
        label={
          <span class="otk-timeline-preview">
            {props.target.text || "Prompt"}
          </span>
        }
        meta={
          <>
            <Show when={props.prompt.queued}>
              <MetaItem rank={2}>
                <ChromeMeta class="otk-timeline-queued">Queued</ChromeMeta>
              </MetaItem>
            </Show>
            <MetaItem rank={1}>
              <MessageFooter
                whole
                intrinsic
                class="otk-timeline-trailing"
                at={props.prompt.time}
                actions={{ kind: "prompt", target: props.target }}
              />
            </MetaItem>
          </>
        }
      />
    </li>
  );
}

/** Data and callbacks only; the selected transcript remains owned by the shell. */
export default function Timeline(props: {
  session?: Selection;
  prompts: TimelinePrompt[];
  state?: CollectionState;
  exhausted: boolean;
  paging: boolean;
  directory?: string;
  preview(prompt: TimelinePrompt): string;
  onOlder(): Promise<void>;
  onReveal(messageID: string): Promise<void>;
}): import("solid-js").Element {
  const [selected, setSelected] = createSignal("");
  const [error, setError] = createSignal<FailureValue>("");
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
        setError(
          failureValue(error, {
            actionLabel: "Revealing prompt in conversation",
          }),
        );
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
        <Show when={props.state === "loading" || !props.exhausted}>
          <Show
            when={props.state !== "loading" && !props.paging}
            fallback={<ProgressStatus text="Loading prompts..." />}
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
        <Show when={props.state === "empty" && !props.paging}>
          <EmptyState>No prompts yet.</EmptyState>
        </Show>
        <VirtualList
          keys={props.prompts.map((prompt) => prompt.id)}
          class="otk-timeline-list"
          label="Acquired prompts"
          samples={[{ role: "prompt", class: "otk-sidebar-row-grid" }]}
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
        <FeedbackStatus feedback={errorFeedback(error())} />
      </Show>
    </section>
  );
}
