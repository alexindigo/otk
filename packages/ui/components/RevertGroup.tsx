// SPDX-License-Identifier: LGPL-3.0-only
import "./RevertGroup.css" with { type: "text" };
import { createMemo, type Element, For, Show } from "solid-js";
import {
  type ActivityGroup as Group,
  type BranchHistory,
  errorFeedback,
  savedBranchProjection,
  type SessionRevert,
  type SessionRevertState,
} from "@otk/client";
import type { Message as RecordMessage, Preferences } from "@otk/protocol";
import ActivityGroup from "./ActivityGroup.tsx";
import Message from "./Message.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import Clock from "./Clock.tsx";
import { CloseIcon, RevertIcon } from "./ChromeIcons.tsx";
import ActivityIndicator from "./ActivityIndicator.tsx";
import FailureContent from "./FailureContent.tsx";
import { BranchCopyRecovery } from "./SavedBranches.tsx";
import FittedActions from "./FittedActions.tsx";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ChangeCounts from "./ChangeCounts.tsx";
import ToolPath from "./tools/ToolPath.tsx";
import RecordList from "./RecordList.tsx";
import { contextTarget } from "./context-target.ts";
import { blocksText } from "./parts/text.ts";
import { TranscriptSnapshot } from "../features/transcript-context.tsx";
import { useUiRegistries } from "../registries/context.tsx";

function preview(message: RecordMessage | undefined): string {
  return message?.parts.map((part) =>
    part.kind === "text"
      ? blocksText(part.blocks)
      : part.kind === "file"
      ? part.name
      : part.kind === "tool"
      ? part.call.tool
      : part.kind === "external"
      ? part.activity?.title ?? ""
      : ""
  ).filter(Boolean).join(" ").split("\n")[0] || message?.id || "";
}
export default function RevertGroup(props: {
  group: Group;
  state: SessionRevertState;
  owner?: SessionRevert;
  history?: BranchHistory;
  prefs: Preferences;
  target?: {
    sidecarId: string;
    sessionID: string;
    directory: string;
    title?: string;
  };
  warning?: string;
  failureVisible?: boolean;
  onOpenCopy?(): void;
  onOpenChild(id: string): void;
}): Element {
  const boundary = () =>
    props.state.record?.boundaryID ?? props.state.confirmation?.messageID;
  const first = () => props.state.messages?.find((m) => m.id === boundary());
  const label = () =>
    props.state.record?.prompt?.input.split("\n")[0] || preview(first()) ||
    boundary();
  const at = () => props.state.record?.prompt?.time ?? first()?.time.created;
  const failure = () =>
    props.failureVisible === false
      ? undefined
      : errorFeedback(props.state.error);
  const pending = () =>
    !!props.state.pending || props.state.phase === "staging" ||
    props.state.phase === "restoring";
  const snapshot = createMemo(() =>
    savedBranchProjection(
      { messages: props.state.messages ?? [], turns: {} },
      props.prefs.showCost,
    )
  );
  return (
    <div
      class="otk-revert-group"
      data-boundary={boundary()}
      data-phase={props.state.phase}
      data-dismissed={props.state.dismissed ? "true" : "false"}
      role={failure() && !props.state.dismissed ? "alert" : undefined}
      tabindex={props.state.dismissed ? 0 : undefined}
      ref={contextTarget(() => ({ kind: "session", data: props.target }))}
    >
      <ActivityGroup
        group={props.group}
        prefs={{ ...props.prefs, expandRecords: false }}
        collapsible={!props.state.dismissed}
        failed={!!failure() && !props.state.dismissed}
        wrapActions
        icon={RevertIcon}
        label={(open) => (
          <span class="otk-revert-heading-content">
            <ChromeMeta class="otk-revert-label otk-control-label">
              <span>Reverted from</span>
              <Show when={at() !== undefined}>
                <Clock at={at()!} />
              </Show>
              <span
                class="otk-revert-preview otk-control-label"
                title={label()}
              >
                {label()}
              </span>
            </ChromeMeta>
            <Show
              when={!open() && !props.state.dismissed && failure()?.failure}
            >
              {(value) => (
                <ChromeMeta
                  class="otk-control-label otk-revert-reason"
                  title={value().reason}
                >
                  {value().reason}
                </ChromeMeta>
              )}
            </Show>
            <Show when={!props.state.dismissed && props.warning}>
              <ChromeMeta
                class="otk-control-label otk-revert-warning"
                title={props.warning}
              >
                {props.warning}
              </ChromeMeta>
            </Show>
          </span>
        )}
        trailing={(open) => (
          <Show when={!props.state.dismissed}>
            <Show when={pending()}>
              <ActivityIndicator
                small
                label={props.state.phase === "restoring"
                  ? "Restoring"
                  : "Reverting"}
              />
            </Show>
            <Show when={pending()}>
              <ChromeMeta>
                {props.state.phase === "restoring"
                  ? "Restoring..."
                  : "Reverting..."}
              </ChromeMeta>
            </Show>
            <Show when={props.state.phase === "saving"}>
              <ActivityIndicator small label="Saving copy" />
              <ChromeMeta>Saving copy...</ChromeMeta>
            </Show>
            <Show when={props.state.phase === "saved"}>
              <ChromeMeta>Copy saved</ChromeMeta>
            </Show>
            <FittedActions
              inline
              items={[
                ...(props.state.phase === "saved" && props.onOpenCopy
                  ? [{
                    key: "open",
                    label: "Open copy",
                    run: () => props.onOpenCopy?.(),
                  }]
                  : []),
                ...(props.state.phase === "staged" && props.state.copyRemoved
                  ? [{
                    key: "save",
                    label: "Save copy",
                    run: () => {
                      void props.owner?.retry();
                    },
                  }]
                  : []),
                ...(!open() && props.state.phase === "failed" &&
                    props.state.record
                  ? [{
                    key: "retry",
                    label: "Retry",
                    run: () => {
                      void props.owner?.retry();
                    },
                  }]
                  : []),
                ...(!pending() && props.owner
                  ? [{
                    key: "restore",
                    label: "Restore",
                    class: "otk-revert-restore",
                    ariaLabel: "Restore conversation",
                    run: () => {
                      void props.owner?.restore();
                    },
                  }, {
                    key: "dismiss",
                    label: "Dismiss revert",
                    icon: CloseIcon,
                    title: "Dismiss revert",
                    run: () => props.owner?.dismiss(),
                  }]
                  : []),
              ]}
            />
          </Show>
        )}
        body={() => (
          <TranscriptSnapshot>
            <div class="otk-revert-records">
              <Show when={failure()?.failure}>
                {(value) => (
                  <FailureContent
                    failure={value()}
                    placement="record"
                    expanded
                    signal={false}
                  />
                )}
              </Show>
              <Show when={failure()?.failure && props.history?.state.recovery}>
                <BranchCopyRecovery owner={props.history!} />
              </Show>
              <For each={props.state.record?.files}>
                {(file) => (
                  <div class="otk-control-row">
                    <span
                      class="otk-control-label otk-control-grow"
                      title={file.path}
                    >
                      <Show when={file.path} fallback="Path not reported">
                        {(path) => (
                          <ToolPath
                            path={path()}
                            directory={props.target?.directory}
                          />
                        )}
                      </Show>
                    </span>
                    <ChangeCounts
                      additions={file.additions}
                      deletions={file.deletions}
                    />
                  </div>
                )}
              </For>
              <Show when={props.warning}>
                <p class="otk-control-label" role="note">{props.warning}</p>
              </Show>
              <RecordList
                items={snapshot().replyIDs}
                key={(id) => id}
                scope={props.group.key}
                revision={(id) => snapshot().repliesByID[id]?.revision ?? 0}
                render={(id) => (
                  <Show when={snapshot().repliesByID[id()]}>
                    {(reply) => (
                      <Message
                        message={reply().message}
                        ownerID={reply().key}
                        segments={reply().segments}
                        prefs={props.prefs}
                        directory={props.target?.directory}
                        permissions={[]}
                        queued={false}
                        readOnly
                        onOpenChild={props.onOpenChild}
                        presentation={snapshot().presentations[id()]}
                      />
                    )}
                  </Show>
                )}
              />
            </div>
          </TranscriptSnapshot>
        )}
      />
    </div>
  );
}

export function RevertConfirmation(props: { owner: SessionRevert }): Element {
  const { tools } = useUiRegistries();
  const kindLabel = (message: RecordMessage) => {
    if (message.role === "user") return "Prompt";
    if (message.role === "assistant") return "Reply";
    return message.parts.map((part) =>
      part.kind === "tool"
        ? tools.presentation(part.call).verb
        : part.kind === "external"
        ? part.activity?.title ?? part.name
        : part.kind === "unknown"
        ? part.label
        : part.kind
    ).filter(Boolean).join(", ") || "Context";
  };
  return (
    <section
      class="otk-revert-confirmation"
      role="region"
      aria-label="Confirm revert"
    >
      <p>Remove this prompt and everything after it</p>
      <For each={props.owner.state.messages}>
        {(message) => (
          <div class="otk-revert-preview-row" data-revert-message={message.id}>
            <ChromeMeta>
              {kindLabel(message)}
            </ChromeMeta>
            <Clock at={message.time.created} />
            <span
              class="otk-control-label otk-revert-preview"
              title={preview(message)}
            >
              {preview(message)}
            </span>
          </div>
        )}
      </For>
      <Show when={props.owner.state.error}>
        <FeedbackStatus error={props.owner.state.error} singleLine />
      </Show>
      <div class="otk-control-row">
        <button
          class="otk-pill"
          type="button"
          onClick={() => void props.owner.confirm()}
        >
          Confirm revert
        </button>
        <button
          class="otk-pill"
          type="button"
          onClick={() => props.owner.cancel()}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
