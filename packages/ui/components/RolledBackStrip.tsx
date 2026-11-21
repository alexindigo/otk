// SPDX-License-Identifier: LGPL-3.0-only
import "./RolledBackStrip.css" with { type: "text" };
import { createSignal, For, onSettled, Show } from "solid-js";
import type { RevertStrip, SessionRevert } from "@otk/client";
import ComposerNotice, { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { ChevronDownIcon, RevertIcon } from "./ChromeIcons.tsx";
import ChangeCounts from "./ChangeCounts.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import { errorFeedback, type FailureValue, failureValue } from "@otk/client";
import OperationFeedback from "./OperationFeedback.tsx";
/** View-local disclosure; operation state and projection belong to the client. */
export default function RolledBackStrip(
  props: {
    strip?: RevertStrip;
    state: SessionRevert["state"];
    preservationWarning?: string;
  },
) {
  return (
    <ComposerNotice>
      <RolledBackContent {...props} />
    </ComposerNotice>
  );
}
export function RolledBackContent(
  props: {
    strip?: RevertStrip;
    state: SessionRevert["state"];
    preservationWarning?: string;
  },
): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const [expanded, setExpanded] = createSignal(false);
  const [feedback, setFeedback] = createSignal<FailureValue>("");
  const [revision, setRevision] = createSignal(0);
  onSettled(() => {
    const invalidate = () => setRevision((value) => value + 1);
    const release = commands.subscribe(invalidate);
    invalidate();
    return release;
  });
  const restore = () => {
    revision();
    return commands.enabled("session.restore")
      ? commands.metadata("session.restore")
      : undefined;
  };
  const perform = async (action: () => Promise<void>) => {
    setFeedback("");
    try {
      await action();
    } catch (error) {
      setFeedback(
        failureValue(error, { actionLabel: "Restoring rolled-back prompts" }),
      );
    }
  };
  return (
    <aside
      class="otk-rolled-back-strip"
      aria-label="Rolled-back prompts"
      aria-busy={props.state.pending ? "true" : undefined}
    >
      <Show when={props.state.error || feedback()}>
        <OperationFeedback
          icon={RevertIcon}
          feedback={errorFeedback(props.state.error || feedback())!}
        />
      </Show>
      <Show when={props.state.pending}>
        <ComposerNoticeRow
          class="otk-rollback-status"
          role="status"
          icon={RevertIcon}
        >
          {props.state.pending === "restore" || props.state.pending === "redo"
            ? "Restoring..."
            : "Rolling back..."}
        </ComposerNoticeRow>
      </Show>
      <Show when={props.strip}>
        {(strip) => (
          <>
            <ComposerNoticeRow
              class="otk-rollback-disclosure"
              icon={RevertIcon}
              expanded={expanded()}
              onClick={() => setExpanded(!expanded())}
              trailing={
                <ChevronDownIcon class={expanded() ? "is-expanded" : ""} />
              }
            >
              <strong>
                Reverted from
              </strong>
              <span
                class="otk-control-label otk-control-grow otk-rollback-preview"
                title={strip().preview}
              >
                {strip().preview}
              </span>
            </ComposerNoticeRow>
            <Show when={props.preservationWarning}>
              <p class="otk-rollback-preservation-warning" role="note">
                {props.preservationWarning}
              </p>
            </Show>
            <Show when={expanded()}>
              <div class="otk-rollback-details">
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
                <span>Your next prompt makes this permanent.</span>
              </div>
            </Show>
            <Show when={restore()}>
              <div class="otk-rollback-footer otk-control-row">
                <button
                  type="button"
                  class="otk-pill"
                  onClick={() =>
                    void perform(() => commands.run("session.restore"))}
                >
                  {restore()?.title}
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
    </aside>
  );
}
