// SPDX-License-Identifier: LGPL-3.0-only
import "./RolledBackStrip.css" with { type: "text" };
import { createSignal, For, Show } from "solid-js";
import type { RevertStrip, SessionRevert } from "@otk/client";
import { countLabel } from "@otk/client";
import ComposerNotice, { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { ChevronDownIcon, CopyIcon, RevertIcon } from "./ChromeIcons.tsx";
import ChangeCounts from "./ChangeCounts.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import { copyContent } from "../features/transcript-context.tsx";
import { errorMessage } from "@otk/protocol";
/** View-local disclosure; operation state and projection belong to the client. */
export default function RolledBackStrip(
  props: { strip?: RevertStrip; state: SessionRevert["state"] },
) {
  const { commands } = useCommandPorts();
  const [expanded, setExpanded] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  const restore = () => commands.enabled("session.restore");
  const perform = async (action: () => Promise<void>) => {
    setFeedback("");
    try {
      await action();
    } catch (error) {
      setFeedback(errorMessage(error));
    }
  };
  return (
    <ComposerNotice>
      <aside
        class="otk-rolled-back-strip"
        aria-label="Rolled-back prompts"
        aria-busy={props.state.pending ? "true" : undefined}
      >
        <Show when={props.state.pending}>
          <div class="otk-rollback-status" role="status">
            <RevertIcon />
            {props.state.pending === "restore" ? "Restoring…" : "Rolling back…"}
          </div>
        </Show>
        <Show when={props.strip}>
          {(strip) => (
            <>
              <ComposerNoticeRow
                class="otk-rollback-disclosure"
                icon={<RevertIcon />}
                expanded={expanded()}
                onClick={() => setExpanded(!expanded())}
                trailing={
                  <ChevronDownIcon class={expanded() ? "is-expanded" : ""} />
                }
              >
                <strong>
                  {countLabel(strip().count, "prompt")} rolled back
                </strong>
                <span
                  class="otk-control-label otk-control-grow otk-rollback-preview"
                  title={strip().preview}
                >
                  {strip().preview}
                </span>
              </ComposerNoticeRow>
              <Show when={expanded()}>
                <div class="otk-rollback-details">
                  <For
                    each={strip().prompts}
                    keyed={(prompt) => prompt.messageID}
                  >
                    {(prompt) => (
                      <div class="otk-rollback-prompt">
                        <span
                          class="otk-control-label otk-control-grow"
                          title={prompt().preview}
                        >
                          {prompt().preview}
                        </span>
                        <time datetime={new Date(prompt().time).toISOString()}>
                          {new Date(prompt().time).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        <button
                          type="button"
                          class="otk-icon-button"
                          aria-label="Copy rolled-back prompt"
                          title="Copy rolled-back prompt"
                          onClick={() =>
                            void perform(() => copyContent(prompt().preview))}
                        >
                          <CopyIcon />
                        </button>
                      </div>
                    )}
                  </For>
                  <Show when={strip().more}>
                    <p class="otk-muted">and {strip().more} more</p>
                  </Show>
                  <For each={strip().files} keyed={(file) => file.path}>
                    {(file) => (
                      <div class="otk-rollback-file">
                        <span
                          class="otk-path otk-control-label otk-control-grow"
                          title={file().path}
                        >
                          {file().path}
                        </span>
                        <span>
                          <ChangeCounts
                            additions={file().additions}
                            deletions={file().deletions}
                          />
                        </span>
                      </div>
                    )}
                  </For>
                  <div class="otk-rollback-footer otk-control-row">
                    <span>Your next prompt makes this permanent.</span>
                    <Show when={restore()}>
                      <button
                        type="button"
                        class="otk-pill"
                        onClick={() =>
                          void perform(() => commands.run("session.restore"))}
                      >
                        Restore
                      </button>
                    </Show>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.state.error || feedback()}>
          <ComposerNoticeRow
            class="otk-error"
            role="alert"
            icon={<RevertIcon />}
          >
            <span
              class="otk-control-label otk-control-grow"
              title={props.state.error || feedback()}
            >
              {props.state.error || feedback()}
            </span>
          </ComposerNoticeRow>
        </Show>
      </aside>
    </ComposerNotice>
  );
}
