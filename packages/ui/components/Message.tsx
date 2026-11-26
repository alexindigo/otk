// SPDX-License-Identifier: LGPL-3.0-only
import { isAssistantTerminal } from "@otk/protocol";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";
import "./Message.css" with { type: "text" };
import {
  errorFeedback,
  messageTimeValue,
  replyErrorFeedback,
} from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { createMemo, For, onSettled, Show } from "solid-js";
import { type MessagePresentation, messagePresentation } from "@otk/client";
import WorkLog from "./WorkLog.tsx";
import RecordKinds from "./RecordKinds.tsx";
import { TreeItem } from "./Tree.tsx";
import EntityPill from "./EntityPill.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import TimeValue from "./TimeValue.tsx";
import ActivityIndicator from "./ActivityIndicator.tsx";
import { ContentWindow, type VirtualListControl } from "./VirtualList.tsx";
import ResponseProgress from "./ResponseProgress.tsx";
import TurnUsage from "./TurnUsage.tsx";
import type { TurnUsage as Usage } from "@otk/client";
import type { UsageSummary } from "@otk/protocol";
import {
  createMessageLayout,
  messageLayoutRole,
  type ReplyStart as ReplyStartData,
} from "./work-log.ts";
import MessageFooter from "./MessageFooter.tsx";
import { contextTarget } from "./context-target.ts";
import type {
  Message as OtkMessage,
  Part,
  PermissionRequest,
} from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
import type { Preferences } from "@otk/protocol";
import type { PartProps } from "../registries/renderers.ts";
import {
  contentGeneration,
  ContentIdentityProvider,
  contentOwner,
  sourceRegion,
  useContentIdentity,
} from "../features/transcript-context.tsx";
function PartView(
  props: {
    part: Part;
    prefs: Preferences;
    streaming: boolean;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth?: number;
    onOpenChild(id: string): void;
    user: boolean;
    pending?: boolean;
    sourceID?: string;
    recordTime?: number;
    failureTime?: number;
  },
) {
  const { parts } = useUiRegistries();
  const identity = useContentIdentity();
  return (
    <Show when={parts.resolve(props.part)} keyed>
      {(renderer) => {
        const Component = renderer;
        return (
          <ContentIdentityProvider
            value={{ ...identity, partID: props.part.id }}
          >
            <div
              ref={sourceRegion(() => props.sourceID ?? identity.messageID!)}
            >
              <Component {...props} />
            </div>
          </ContentIdentityProvider>
        );
      }}
    </Show>
  );
}
/** A stable keyed component boundary preserves source nodes during part updates. */
function PartsView(
  props: Omit<PartProps, "part" | "recordTime" | "failureTime"> & {
    parts: Part[];
    sourceID?(part: Part): string;
    recordTime?(part: Part): number | undefined;
    failureTime?(part: Part): number | undefined;
    tree?: boolean;
  },
) {
  const generation = contentGeneration();
  return (
    <ContentWindow
      items={props.parts}
      key={(part) => generation(part.id)}
      label="Reply parts"
      render={(part) => (
        <TreeItem
          connected={props.tree === true}
          last={part().id === props.parts.at(-1)?.id}
        >
          <PartView
            part={part()}
            prefs={props.prefs}
            directory={props.directory}
            permissions={props.permissions}
            onOpenChild={props.onOpenChild}
            user={props.user}
            streaming={props.streaming}
            pending={props.pending}
            sourceID={props.sourceID?.(part())}
            recordTime={props.recordTime?.(part())}
            failureTime={props.failureTime?.(part())}
          />
        </TreeItem>
      )}
    />
  );
}
export interface MessageControl {
  reveal(): void;
  revealWork(): Promise<void>;
}
function ReplyStart(props: {
  source: ReplyStartData;
  sessionID: string;
}) {
  const session = useOptionalSessionPorts();
  return (
    <span
      class="otk-reply-start"
      data-reply-source={props.source.messageID}
    >
      <EntityPill
        label={props.source.agent}
        facts={scopedEntityFacts(session, {
          sessionID: props.sessionID,
          turnID: props.source.turnID ?? props.source.messageID,
          timing: props.source.timing,
          outcomeTime: props.source.outcomeTime,
          model: props.source.model,
        })}
      />
    </span>
  );
}
export default function Message(
  props: {
    sidecarId?: string;
    sessionTitle?: string;
    ownerID?: string;
    message: OtkMessage;
    sourceTime?(messageID: string): number | undefined;
    sourceOutcomeTime?(
      messageID: string,
    ): import("@otk/protocol").OutcomeTime | undefined;
    segments?: import("@otk/client").TranscriptReply["segments"];
    lastID?: string;
    pending?: boolean;
    send?: import("@otk/client").TranscriptReply["send"];
    recovery?: "recovering" | "unavailable";
    onRetryRecovery?(): void;
    metadata?: import("@otk/protocol").AssistantMessage | null;
    usage?: Usage;
    summary?: import("@otk/protocol").Derived<UsageSummary>;
    openUsage?(): () => void;
    /** Injected disclosure for producer-owned successful completion facts. */
    completion?: { key: string; body(): import("solid-js").Element };
    usageError?(): import("@otk/client").FailureValue | undefined;
    prefs: Preferences;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth?: number;
    onOpenChild(id: string): void;
    queued: boolean;
    /** Saved presentation has no live-history mutation or usage actions. */
    readOnly?: boolean;
    presentation?: MessagePresentation;
    control?(control: MessageControl): (() => void) | void;
    copySource?(
      id: string,
      text: (part: Part) => string | undefined,
    ): Promise<string>;
    copyIncomplete?: boolean;
    /** The transcript's one in-flow progress for an active native record. */
    activeRecord?: boolean;
  },
): import("solid-js").Element {
  const { parts } = useUiRegistries();
  const layout = createMessageLayout();
  const sourceID = (part: Part) => layout.source(part.id) ?? props.message.id;
  const recordTime = (part: Part) => {
    const record = parts.presentation(part, props.prefs).failure?.facts?.record;
    if (record) {
      return props.sourceTime?.(record.messageID) ??
        (props.message.role === "context" &&
            props.message.id === record.messageID
          ? props.message.time.created
          : undefined);
    }
    return props.message.role === "context"
      ? props.sourceTime?.(sourceID(part)) ??
        (sourceID(part) === props.message.id
          ? props.message.time.created
          : undefined)
      : undefined;
  };
  const framing = createMemo(() =>
    layout.update(
      props.ownerID ?? props.message.id,
      messageLayoutRole(props.message),
      props.segments ??
        [{
          messageID: props.message.id,
          parts: props.message.parts,
          ...(props.message.role === "assistant"
            ? {
              agent: props.message.agent,
              turnID: props.message.replyTo ?? props.message.id,
              model: props.message.model,
              time: props.message.time,
            }
            : {}),
        }],
      JSON.stringify(props.prefs),
      (part) => parts.presentation(part, props.prefs),
    )
  );
  const frames = () => framing().frames;
  const failureTime = (part: Part) => {
    const id =
      parts.presentation(part, props.prefs).failure?.facts?.record?.messageID ??
        sourceID(part);
    const time = props.sourceOutcomeTime?.(id) ??
      (id === props.message.id && props.message.role !== "user"
        ? props.message.outcomeTime
        : undefined);
    return time?.state === "known" && time.at !== outcomeClock()?.at
      ? time.at
      : undefined;
  };
  const userBubble = () => framing().userBubble;
  const prompt = () => framing().prompt;
  const identity = () => ({
    ownerID: props.ownerID,
    sidecarId: props.sidecarId,
    sessionID: props.message.sessionID,
    label: props.sessionTitle,
    messageID: props.message.id,
    directory: props.directory,
  });
  let footerControl: VirtualListControl | undefined;
  let usageControl: { open(): void } | undefined;
  const replySources = () =>
    frames().flatMap((frame) =>
      frame.groups.flatMap((group) => group.replyStart ?? [])
    );
  const workGroup = () => frames().at(-1)?.groups.at(-1)?.work;
  const segmentWindows = new Map<string, VirtualListControl>();
  contentOwner(identity, {
    get usage() {
      return props.openUsage
        ? async () => {
          await footerControl?.reveal("footer", {
            align: "nearest",
            intent: "user",
          });
          usageControl?.open();
        }
        : undefined;
    },
  });
  const text = () =>
    (assistant()?.parts ?? props.message.parts).map((part) =>
      parts.presentation(part, props.prefs).text
    ).filter(Boolean).join("\n\n");
  let article!: HTMLElement;
  let bubble: HTMLDivElement | undefined;
  onSettled(() =>
    props.control?.({
      reveal() {
        (prompt() && bubble ? bubble : article).focus({ preventScroll: true });
      },
      async revealWork() {
        const frame = frames().at(-1), group = frame?.groups.at(-1);
        if (frame && group?.work) {
          await segmentWindows.get(frame.id)?.reveal(group.id, {
            align: "nearest",
            intent: "user",
          });
        }
      },
    })
  );
  const target = () => ({
    ...identity(),
    source: framing().copyable || props.copyIncomplete
      ? () =>
        props.copySource
          ? props.copySource(
            props.message.id,
            (part) => parts.presentation(part, props.prefs).text,
          )
          : text()
      : undefined,
    lastID: props.lastID ?? props.message.id,
    completed: isAssistantTerminal(props.message),
    queued: props.queued || !!props.send && props.send.phase !== "committed",
  });
  const assistant = () =>
    props.metadata === null ? undefined : props.metadata ??
      (props.message.role === "assistant" ? props.message : undefined);
  const presentation = () =>
    props.presentation ??
      messagePresentation(
        props.message,
        props.summary,
        "live",
        props.activeRecord,
      );
  const streaming = () => presentation().streaming;
  const progress = () => presentation().progress;
  const outcomeClock = createMemo(() => {
    const time = presentation().time?.outcome;
    return time?.state === "known" ? time : undefined;
  });
  const error = () =>
    replyErrorFeedback(
      props.message,
      frames().flatMap((frame) =>
        frame.groups.flatMap((group) => group.parts).flatMap((part) => {
          const failure = parts.presentation(part, props.prefs).failure;
          return failure ? [failure] : [];
        })
      ),
      identity(),
    );
  return (
    <ContentIdentityProvider value={identity()}>
      <article
        ref={[
          (element) => {
            article = element;
          },
          contextTarget(() => ({
            kind: props.readOnly
              ? "saved-message"
              : prompt()
              ? "prompt"
              : "reply",
            data: target(),
          })),
        ]}
        class={["otk-message", {
          "otk-user-message": userBubble(),
        }]}
        data-message={props.message.id}
        data-role={props.message.role}
        data-send-state={props.send?.phase}
        data-send-key={props.send?.intent.key}
        tabindex="-1"
      >
        <For each={frames()} keyed={(frame) => frame.id}>
          {(frame) => (
            <div
              class={frame().transcript
                ? "otk-transcript-frame"
                : userBubble()
                ? "otk-user-bubble otk-created-trigger"
                : "otk-message-content"}
              ref={(element) => {
                // Parts may arrive after this frame mounts. Keep its reference
                // independently of the current prompt projection.
                if (!frame().transcript) {
                  bubble = element;
                }
              }}
              tabindex={!frame().transcript && prompt() ? "0" : undefined}
              data-otk-focus={!frame().transcript && prompt()
                ? "content"
                : undefined}
            >
              <ContentWindow
                items={frame().groups}
                intrinsic={userBubble() && !frame().transcript}
                scope={frame().id}
                key={(group) => group.id}
                label="Reply segments"
                role="segment"
                control={(control) => {
                  const id = frame().id;
                  segmentWindows.set(id, control);
                  return () => segmentWindows.delete(id);
                }}
                render={(group) => (
                  <Show
                    when={group().work}
                    fallback={
                      <>
                        <PartsView
                          parts={group().parts}
                          prefs={props.prefs}
                          directory={props.directory}
                          permissions={props.permissions}
                          onOpenChild={props.onOpenChild}
                          user={props.message.role === "user"}
                          streaming={streaming()}
                          pending={props.pending}
                          sourceID={sourceID}
                          recordTime={recordTime}
                          failureTime={failureTime}
                        />
                      </>
                    }
                  >
                    <RecordKinds
                      items={group().parts}
                      activity={(part) =>
                        parts.presentation(part, props.prefs).activity}
                      prefs={props.prefs}
                      identity={group().id}
                      render={(visible, meta) => (
                        <WorkLog
                          owner={props.ownerID ?? props.message.id}
                          records={[
                            ...group().parts.map((part) => part.id),
                            ...(props.completion ? [props.completion.key] : []),
                          ]}
                          prefs={props.prefs}
                          required={group().required}
                          meta={meta}
                          body={() => (
                            <>
                              <PartsView
                                tree
                                parts={visible()}
                                prefs={props.prefs}
                                directory={props.directory}
                                permissions={props.permissions}
                                onOpenChild={props.onOpenChild}
                                user={props.message.role === "user"}
                                streaming={streaming()}
                                pending={props.pending}
                                sourceID={sourceID}
                                recordTime={recordTime}
                                failureTime={failureTime}
                              />
                              {props.completion?.body()}
                            </>
                          )}
                        />
                      )}
                    />
                  </Show>
                )}
              />
              <Show when={progress() && frame().id === frames().at(-1)?.id}>
                <ResponseProgress />
              </Show>
            </div>
          )}
        </For>
        <Show when={props.recovery}>
          <FeedbackStatus
            feedback={props.recovery === "unavailable"
              ? {
                ...errorFeedback("Response refresh unavailable.", {
                  actionLabel: "Refreshing response",
                  target: identity(),
                })!,
                action: props.onRetryRecovery
                  ? { label: "Retry response", run: props.onRetryRecovery }
                  : undefined,
              }
              : { kind: "pending", text: "Refreshing response..." }}
          />
        </Show>
        <Show when={prompt()}>
          <MessageFooter
            class="otk-user-meta"
            at={props.message.time.created}
            actions={!props.readOnly &&
                (!props.send || props.send.phase === "committed")
              ? { kind: "prompt", target: target() }
              : undefined}
          >
            <Show when={props.send?.phase === "pending"}>
              <ChromeMeta class="otk-send-meta">
                <ActivityIndicator small decorative />Sending
              </ChromeMeta>
            </Show>
            <Show
              when={props.queued &&
                (!props.send || props.send.phase === "committed")}
            >
              <ChromeMeta class="otk-queued">Queued</ChromeMeta>
            </Show>
          </MessageFooter>
          <Show when={props.send?.phase === "failed"}>
            <FeedbackStatus
              class="otk-send-failure"
              intrinsic
              feedback={props.send?.feedback}
            />
          </Show>
        </Show>
        <Show when={assistant()}>
          {(message) => (
            <div
              class={["otk-reply-end", {
                "has-work": workGroup() || !!props.completion,
              }]}
            >
              <Show when={!workGroup() && props.completion}>
                {(completion) => (
                  <div class="otk-reply-end-work">
                    <WorkLog
                      owner={props.ownerID ?? props.message.id}
                      records={[completion().key]}
                      prefs={props.prefs}
                      body={() => completion().body()}
                    />
                  </div>
                )}
              </Show>
              <ContentWindow
                items={["footer"]}
                key={(key) => key}
                label="Reply metadata"
                role="metadata"
                control={(control) => {
                  footerControl = control;
                }}
                render={() => (
                  <MessageFooter
                    whole
                    leading={
                      <For
                        each={replySources()}
                        keyed={(source) => source.messageID}
                      >
                        {(source) => (
                          <ReplyStart
                            source={{
                              ...source(),
                              timing: presentation().time?.timing,
                              outcomeTime: presentation().time?.outcome,
                            }}
                            sessionID={props.message.sessionID}
                          />
                        )}
                      </For>
                    }
                    ref={sourceRegion(() => props.lastID ?? props.message.id)}
                    at={outcomeClock()?.at}
                    actions={!props.readOnly
                      ? { kind: "reply", target: target() }
                      : undefined}
                    duration={
                      <Show
                        when={presentation().time?.timing ||
                          presentation().time?.fallback}
                      >
                        <TimeValue
                          class="otk-turn-time"
                          value={messageTimeValue(presentation().time)}
                        />
                      </Show>
                    }
                  >
                    <span>
                      {message().model.provider}/{message().model.model}
                    </span>
                    <Show when={presentation().usage}>
                      {(usage) => (
                        <TurnUsage
                          summary={usage().summary}
                          detail={() => props.usage}
                          error={props.usageError}
                          open={props.openUsage}
                          control={(control) => {
                            usageControl = control;
                          }}
                          showCost={props.prefs.showCost}
                        />
                      )}
                    </Show>
                    <For each={presentation().facts}>
                      {(text) => <span>{text}</span>}
                    </For>
                    <Show when={message().interrupted}>
                      <span>interrupted</span>
                    </Show>
                  </MessageFooter>
                )}
              />
            </div>
          )}
        </Show>
        <Show when={error()}>
          <FeedbackStatus
            feedback={error()}
          />
        </Show>
      </article>
    </ContentIdentityProvider>
  );
}
