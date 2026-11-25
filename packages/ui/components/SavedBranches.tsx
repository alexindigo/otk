// SPDX-License-Identifier: LGPL-3.0-only
import "./SavedBranches.css" with { type: "text" };
import { clockTitle } from "./Clock.tsx";
import { createMemo, For, Show } from "solid-js";
import {
  age,
  branchDraftLabels,
  type BranchHistory,
  errorFeedback,
  isReplaced,
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
import FittedActions from "./FittedActions.tsx";
import TimeText from "./TimeText.tsx";
import { TranscriptSnapshot } from "../features/transcript-context.tsx";
export function RevertSendChoice(
  props: { owner: BranchHistory },
): import("solid-js").Element {
  const choice = () => props.owner.state.permanence;
  const perform = (action: () => Promise<void>) => {
    void action().catch((cause) => props.owner.fail(cause));
  };
  return (
    <Show when={choice()}>
      {(pending) => (
        <div class="otk-permanence-choice">
          <OperationFeedback feedback={errorFeedback(pending().error)!} />
          <ComposerNoticeRow>
            <FittedActions
              items={[
                {
                  key: "save",
                  label: pending().saving ? "Saving copy..." : "Save copy",
                  disabled: pending().saving ||
                    !!props.owner.preservationWarning(),
                  title: props.owner.preservationWarning(),
                  run: () => perform(() => props.owner.saveCopy()),
                },
                {
                  key: "send",
                  label: "Send anyway",
                  disabled: pending().saving,
                  run: () => perform(() => props.owner.sendAnyway()),
                },
                {
                  key: "cancel",
                  label: "Cancel",
                  run: () => props.owner.cancelSend(),
                },
              ]}
            />
          </ComposerNoticeRow>
        </div>
      )}
    </Show>
  );
}

export function SavedBranchNotice(
  props: {
    owner: BranchHistory;
    failureVisible?: boolean;
    recoveryVisible?: boolean;
    statusVisible?: boolean;
  },
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
      <Show
        when={props.recoveryVisible !== false && state().recovery &&
          !state().permanence}
      >
        <ComposerNoticeRow>
          <BranchCopyRecovery owner={props.owner} />
        </ComposerNoticeRow>
      </Show>
      <Show when={props.statusVisible !== false && state().pending}>
        <ComposerNoticeRow icon={RevertIcon} role="status">
          Saving the earlier conversation...
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
export function BranchCopyRecovery(props: { owner: BranchHistory }) {
  return (
    <FittedActions
      items={[
        {
          key: "retry",
          label: props.owner.state.pending ? "Saving copy..." : "Retry",
          disabled: props.owner.state.pending,
          run: () => {
            void props.owner.retryCopy().catch((cause) =>
              props.owner.fail(cause)
            );
          },
        },
        {
          key: "keep",
          label: "Keep without a saved copy",
          disabled: props.owner.state.pending,
          title:
            "Keep the live conversation and current draft without saving the earlier conversation",
          run: () => props.owner.keepWithoutCopy(),
        },
      ]}
    />
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
  const committed = createMemo(() => {
    const saved = branch();
    return saved && isReplaced(saved)
      ? age(saved.committedAt!, Date.now())
      : undefined;
  });
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
                  <Show
                    when={committed()}
                    fallback="Saved before a revert, not replaced"
                  >
                    {(time) => (
                      <>
                        Replaced when a revert was committed{" "}
                        <TimeText time={time()} />
                        {time().word ? "" : " ago"}
                      </>
                    )}
                  </Show>
                </p>
                <p>
                  You can read this copy and reuse its prompts. Files are not
                  restored.
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
