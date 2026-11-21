// SPDX-License-Identifier: LGPL-3.0-only
import "./SavedBranches.css" with { type: "text" };
import { clockTitle } from "./Clock.tsx";
import { createMemo, For, Show } from "solid-js";
import {
  branchDraftLabels,
  type BranchHistory,
  errorFeedback,
  savedBranchProjection,
  savedPromptDraft,
} from "@otk/client";
import type { Preferences } from "@otk/protocol";
import { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { RevertIcon } from "./ChromeIcons.tsx";
import OperationFeedback from "./OperationFeedback.tsx";
import Message from "./Message.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import VirtualList from "./VirtualList.tsx";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { TranscriptSnapshot } from "../features/transcript-context.tsx";

export function SavedBranchNotice(
  props: { owner: BranchHistory; failureVisible?: boolean },
) {
  const state = () => props.owner.state;
  const perform = (action: () => void) => {
    try {
      action();
    } catch (cause) {
      props.owner.fail(cause);
    }
  };
  return (
    <>
      <Show when={props.failureVisible !== false && state().error}>
        <OperationFeedback feedback={errorFeedback(state().error)!} />
      </Show>
      <Show when={state().pending}>
        <ComposerNoticeRow icon={RevertIcon} role="status">
          Saving earlier branch...
        </ComposerNoticeRow>
      </Show>
      <Show when={state().branches.length}>
        <ComposerNoticeRow icon={RevertIcon}>
          <button
            type="button"
            class="otk-pill"
            onClick={() => props.owner.open(state().branches[0].id)}
          >
            Unrevert: {state().branches.length} saved earlier{" "}
            {state().branches.length === 1 ? "branch" : "branches"}
          </button>
        </ComposerNoticeRow>
      </Show>
      <Show when={state().choice}>
        {(choice) => (
          <div class="otk-saved-choice">
            <p>
              Your current draft and the {choice().label.toLowerCase()}{" "}
              are both kept. Which should be in the composer?
            </p>
            <div class="otk-control-row">
              <button
                type="button"
                class="otk-pill"
                onClick={() => perform(() => props.owner.choose(true))}
              >
                Use {choice().label.toLowerCase()}
              </button>
              <button
                type="button"
                class="otk-pill"
                onClick={() => props.owner.choose(false)}
              >
                Keep current draft
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
export default function SavedBranches(
  props: {
    owner: BranchHistory;
    prefs: Preferences;
    onOpenChild(id: string): void;
  },
) {
  const branch = () =>
    props.owner.state.branches.find((b) => b.id === props.owner.state.opened);
  const projection = createMemo(() =>
    savedBranchProjection(branch(), props.prefs.showCost)
  );
  const perform = (action: () => void) => {
    try {
      action();
    } catch (cause) {
      props.owner.fail(cause);
    }
  };
  let viewport: HTMLDivElement | undefined;
  return (
    <Show when={branch()}>
      {(saved) => (
        <TranscriptSnapshot>
          <section
            class="otk-saved-branch"
            role="region"
            aria-label="Saved earlier branch"
          >
            <header class="otk-saved-toolbar">
              <div class="otk-saved-toolbar-content otk-control-row">
                <h2 class="otk-control-label otk-control-grow">
                  Saved earlier branch
                </h2>
                <button
                  type="button"
                  class="otk-pill"
                  onClick={() => props.owner.open()}
                >
                  Back to live conversation
                </button>
                <button
                  type="button"
                  class="otk-pill"
                  onClick={() => perform(() => props.owner.delete(saved().id))}
                >
                  Delete saved branch
                </button>
              </div>
            </header>
            <ScrollRegion
              axis="y"
              class="otk-saved-messages"
              ref={(element) => {
                viewport = element;
              }}
            >
              <div class="otk-saved-header">
                <p>
                  {saved().replaced
                    ? "This earlier branch was replaced; you can read it and reuse its prompts."
                    : "This is a saved earlier branch; you can read it and reuse its prompts."}
                  {" "}
                  It is not live native history. Replaced messages cannot be
                  restored to native history. Files are not restored.
                </p>
                <p>
                  Saved in this browser {clockTitle(saved().created)}{" "}
                  ({saved().bytes.toLocaleString()}{" "}
                  bytes). Kept until you delete it.
                </p>
                <Show when={props.owner.state.branches.length > 1}>
                  <nav
                    class="otk-control-row"
                    aria-label="Saved branches"
                    data-otk-selection="horizontal"
                  >
                    <For each={props.owner.state.branches} keyed={(b) => b.id}>
                      {(b) => (
                        <button
                          type="button"
                          data-otk-selection="horizontal"
                          {...selection({
                            selected: b().id === saved().id,
                            kind: "current",
                            class: "otk-pill",
                          })}
                          onClick={() => props.owner.open(b().id)}
                        >
                          <SelectionContent>
                            {clockTitle(b().created)}
                          </SelectionContent>
                        </button>
                      )}
                    </For>
                  </nav>
                </Show>
                <For
                  each={saved().drafts}
                  keyed={(d) => d.label + JSON.stringify(d.value)}
                >
                  {(draft) => (
                    <div class="otk-control-row">
                      <span
                        class="otk-control-label otk-control-grow"
                        title={draft().value.input}
                      >
                        {draft().label}:{" "}
                        {draft().value.input || (draft().value.chips.length
                          ? "Attachments"
                          : "Empty draft")}
                      </span>
                      <button
                        type="button"
                        class="otk-pill"
                        onClick={() =>
                          perform(() =>
                            props.owner.reuse(
                              saved().id,
                              draft().value,
                              branchDraftLabels.savedDraft,
                            )
                          )}
                      >
                        Use draft: {draft().label}
                      </button>
                    </div>
                  )}
                </For>
              </div>
              <VirtualList
                keys={projection().replyIDs}
                label="Saved branch messages"
                viewport={() => viewport}
                samples={[{
                  role: "reply",
                  class: "otk-window-reply-estimate",
                }]}
                role={() => "reply"}
                overscan={0}
                render={(id) => (
                  <Show when={projection().repliesByID[id]}>
                    {(reply) => {
                      const prompt = () =>
                        saved().prompts.find((p) =>
                          p.messageID === reply().message.id
                        );
                      return (
                        <div class="otk-saved-message">
                          <Message
                            message={reply().message}
                            segments={reply().segments}
                            prefs={props.prefs}
                            directory={saved().session.directory}
                            permissions={[]}
                            onOpenChild={props.onOpenChild}
                            queued={false}
                            readOnly
                            presentation={projection().presentations[id]}
                          />
                          <Show when={prompt()}>
                            {(p) => (
                              <div class="otk-saved-reuse">
                                <button
                                  type="button"
                                  class="otk-pill"
                                  onClick={() =>
                                    perform(() =>
                                      props.owner.reuse(
                                        saved().id,
                                        savedPromptDraft(p().entry),
                                        branchDraftLabels.savedPrompt,
                                      )
                                    )}
                                >
                                  Reuse prompt
                                </button>
                              </div>
                            )}
                          </Show>
                        </div>
                      );
                    }}
                  </Show>
                )}
              />
            </ScrollRegion>
          </section>
        </TranscriptSnapshot>
      )}
    </Show>
  );
}
