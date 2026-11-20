// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import { EmptyState } from "./View.tsx";
import "./SessionView.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import { isCancellation } from "@otk/protocol";
import {
  createEffect,
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import type {
  ContentSession,
  IndexEntry,
  Message as OtkMessage,
  ModelCatalog,
  PermissionRequest,
  RevertInfo,
} from "@otk/protocol";
import Message, { type MessageControl } from "./Message.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import RecordList from "./RecordList.tsx";
import { activeProgressRecord } from "./work-log.ts";
import { PathProvider } from "./PathProvider.tsx";
import Prompt from "./Prompt.tsx";
import ComposerTakeovers from "./ComposerTakeovers.tsx";
import type { Preferences } from "@otk/protocol";
import SubagentBar from "./SubagentBar.tsx";
import { RolledBackContent } from "./RolledBackStrip.tsx";
import SavedBranches, { SavedBranchNotice } from "./SavedBranches.tsx";
import { ForkFact } from "./ForkNote.tsx";
import ComposerNotice from "./ComposerNotice.tsx";
import OperationFeedback from "./OperationFeedback.tsx";
import PaneState from "./PaneState.tsx";
import ProgressStatus from "./ProgressStatus.tsx";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { bindFeedback } from "../state/feedback.ts";
import { useSessionPorts } from "../registries/session.tsx";
import SessionError from "./SessionError.tsx";
import type { SessionErrorState } from "@otk/protocol";
import {
  contextualFailure,
  createTranscriptInteraction,
  createTranscriptProjection,
  errorFeedback,
  type FailureValue,
  failureValue,
  placeFailure,
  replyKey,
  RequestFailure,
  revertPresentation,
  sessionComposerFeedback,
  sessionResult,
  type SessionUsageOwner,
  type TranscriptOwner,
} from "@otk/client";
import {
  followViewport,
  sourceViewport,
  type ViewportSnapshot,
} from "./viewport.ts";
import JumpToLatest from "./JumpToLatest.tsx";
import MessageDelivery from "./MessageDelivery.tsx";
import { highlightingScope } from "../highlight/client.ts";
import {
  HighlightProvider,
  transcriptHighlightLease,
} from "../highlight/context.tsx";
import type { Draft, DraftChange } from "./prompt/model.ts";
import type { PromptProps } from "../registries/prompt.ts";
import {
  commandHints,
  ownedAction,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
import { TranscriptContext } from "../features/transcript-context.tsx";
import { contextTarget } from "./context-target.ts";
import VirtualList, { type VirtualListControl } from "./VirtualList.tsx";
export default function SessionView(props: {
  sidecarId?: string;
  info?: ContentSession;
  label: string;
  messages?: OtkMessage[];
  transcript?: TranscriptOwner;
  latestPrompt?: import("@otk/protocol").LatestPrompt;
  catalog?: ModelCatalog;
  usageOwner?: SessionUsageOwner;
  entry?: IndexEntry;
  openUsage?(turnID: string): () => void;
  usageError?(turnID: string): FailureValue | undefined;
  loading: boolean;
  continuity?: "loading" | "ready" | "missing";
  paging: boolean;
  exhausted: boolean;
  error?: string | FailureValue;
  sessionError?: string;
  errorState?: SessionErrorState;
  draft: Draft;
  forkNote?: import("@otk/client").ForkNote;
  onDismissForkNote?(): void;
  connected: boolean;
  displayMenu?: Element;
  prefs: Preferences;
  permissions: PermissionRequest[];
  siblings: import("@otk/protocol").SessionStructure[];
  onOpenChild(id: string): void;
  child: boolean;
  revert: RevertInfo | null;
  rollback?: import("@otk/client").SessionRevert;
  branchHistory?: import("@otk/client").BranchHistory;
  strip?: import("@otk/client").RevertStrip;
  busy: boolean;
  retryState?: { attempt: number; message: string; next: number };
  onOlder(): Promise<void>;
  onRetry(): Promise<void>;
  onDraft(value: DraftChange): Draft;
  onPrompt: PromptProps["onSubmit"];
  onAbort(): Promise<void>;
}): Element {
  const writeDraft = props.onDraft;
  const sessionPorts = useSessionPorts();
  const feedbackOwner = sessionPorts?.feedback;
  const requestFeedback = bindFeedback(() => feedbackOwner);
  const rollbackPresentation = createMemo(() =>
    revertPresentation(
      props.rollback?.state ?? {},
      requestFeedback(),
      props.branchHistory?.state.error,
    )
  );
  const failureTarget = () => ({
    sidecarId: props.sidecarId,
    sessionID: props.info?.id,
    label: props.info?.title,
  });
  const feedback = createMemo(() =>
    sessionComposerFeedback(
      props.errorState,
      failureTarget(),
      rollbackPresentation().feedback,
    )
  );
  let noticeControl: { focus(): void } | undefined;
  const revealLifetime = new AbortController();
  onCleanup(() => revealLifetime.abort());
  const highlightLease = createMemo(() =>
    props.transcript ? transcriptHighlightLease(props.transcript) : undefined
  );
  // The selected facade can release its resource before this view and its
  // commands unmount. Keep the compatibility projection valid independently.
  const fallbackProjection = createTranscriptProjection();
  const fallback = createMemo(() => {
    fallbackProjection.replace(props.messages ?? []);
    fallbackProjection.busy(props.busy);
    return fallbackProjection.state;
  });
  const interaction = props.transcript?.interaction ??
    createTranscriptInteraction();
  const projection = () => props.transcript?.state ?? fallback();
  const recordGroups = () => projection().records;
  const recordWindows = new Map<string, VirtualListControl>();
  const recordWindow = (key: string, control: VirtualListControl) => {
    recordWindows.set(key, control);
    return () => {
      if (recordWindows.get(key) === control) recordWindows.delete(key);
    };
  };
  const renderGroup = (key: string, one: (key: string) => Element) => {
    return (
      <Show when={recordGroups().groups[key]} fallback={one(key)}>
        {(group) => (
          <ActivityGroup
            group={group()}
            onOpenChild={props.onOpenChild}
            prefs={props.prefs}
            body={() => (
              <RecordList
                items={group().children ?? []}
                key={(child) => child.key}
                scope={group().key}
                control={(control) => recordWindow(group().key, control)}
                revision={(child) => child.revision}
                outgoing={group().direction === "outgoing"}
                render={(child) => (
                  <Show when={child().count} fallback={one(child().key)}>
                    <ActivityGroup
                      group={child()}
                      onOpenChild={props.onOpenChild}
                      prefs={props.prefs}
                      body={() => (
                        <RecordList
                          items={child().members}
                          key={(key) => key}
                          scope={child().key}
                          control={(control) =>
                            recordWindow(child().key, control)}
                          revision={(key) =>
                            projection().repliesByID[key]?.revision ?? 0}
                          outgoing={child().direction === "outgoing"}
                          render={(key) =>
                            one(key())}
                        />
                      )}
                    />
                  </Show>
                )}
              />
            )}
          />
        )}
      </Show>
    );
  };
  const count = () => projection().messageIDs.length;
  // One in-flow progress per active turn: an unfinished reply owns it;
  // otherwise the turn's newest active native record does.
  const progressRecord = createMemo(() => activeProgressRecord(projection()));
  const transcriptBusy = () =>
    props.loading || props.paging ||
    props.continuity === "loading" || props.continuity === "missing";
  const rollbackNotice = () =>
    !!props.strip || !!props.rollback?.state.pending ||
    !!props.rollback?.state.error;
  const rollbackState = () => rollbackPresentation().state;
  const savedNotice = () =>
    !!props.branchHistory &&
    (!!props.branchHistory.state.branches.length ||
      !!props.branchHistory.state.error || props.branchHistory.state.pending);
  const noticed = () =>
    rollbackNotice() || savedNotice() || !!props.forkNote || !!feedback();
  const branchFailureVisible = () => {
    const value = props.branchHistory?.state.error;
    return !value || value.diagnosticID !== feedback()?.diagnosticID;
  };
  // The slot's identity is its mounted lifetime, not each feedback publication.
  const notice = () => (
    <ComposerNotice>
      <Show when={feedback()}>
        {(value) => (
          <OperationFeedback
            feedback={value()}
            onReveal={(messageID) =>
              void reveal({ messageID }).catch((cause) =>
                setRevealError(failureValue(cause))
              )}
            control={(control) => noticeControl = control}
          />
        )}
      </Show>
      <Show when={rollbackNotice()}>
        <RolledBackContent
          strip={props.strip}
          state={rollbackState()}
          preservationWarning={props.branchHistory?.preservationWarning()}
        />
      </Show>
      <Show when={props.branchHistory}>
        {(owner) => (
          <SavedBranchNotice
            owner={owner()}
            failureVisible={branchFailureVisible()}
          />
        )}
      </Show>
      <Show when={props.forkNote}>
        {(note) => (
          <ForkFact
            note={note()}
            onDismiss={() => props.onDismissForkNote?.()}
          />
        )}
      </Show>
    </ComposerNotice>
  );
  const [now, setNow] = createSignal(Date.now());
  const [revealError, setRevealError] = createSignal<FailureValue>();
  const older = ownedAction("session.page", () => props.onOlder());
  const retry = ownedAction("session.refetch", () => {
    setRevealError(undefined);
    return props.onRetry();
  });
  let list!: HTMLDivElement, flow!: HTMLDivElement;
  let following: ReturnType<typeof followViewport> | undefined;
  const [geometry, setGeometry] = createSignal<ViewportSnapshot>();
  const commandPorts = useCommandPorts(), hints = commandHints(commandPorts);
  const latest = ownedCommand(commandPorts, {
    id: "transcript.latest",
    name: "latest",
    title: "Jump to latest",
    category: "Transcript",
    scope: "session",
    enabled: () => !!following && !!count(),
    run: () =>
      following!.latest((signal) =>
        props.transcript?.latest(signal) ?? Promise.resolve()
      ),
  });
  const publishHistory = () =>
    following?.history({
      appendRevision: props.transcript?.state.appendRevision ??
        fallback().appendRevision,
      first: projection().messageIDs[0],
      last: projection().messageIDs.at(-1),
      exhausted: props.exhausted,
    });
  createEffect(() => ({
    appendRevision: props.transcript?.state.appendRevision ??
      fallback().appendRevision,
    first: projection().messageIDs[0],
    last: projection().messageIDs.at(-1),
    exhausted: props.exhausted,
  }), () => publishHistory());
  let followIntent = true;
  let window: VirtualListControl | undefined;
  let source: ReturnType<typeof sourceViewport> | undefined;
  const regions = new Map<HTMLElement, { id: string; release?: () => void }>();
  const attachSource = (element: HTMLElement, id: string) => {
    const region = { id, release: source?.attach(element, id) };
    regions.set(element, region);
    return () => {
      regions.delete(element);
      region.release?.();
    };
  };
  const controls = new Map<string, MessageControl>();
  const reveal = ownedCommand(useCommandPorts(), {
    id: "transcript.reveal",
    title: "Reveal message",
    category: "Transcript",
    arguments: {
      type: "object",
      properties: { messageID: { type: "string" } },
    },
    enabled: (_ctx, target?: { messageID: string }) =>
      !props.branchHistory?.state.opened && !!target?.messageID &&
      (!!projection().messagesByID[target.messageID] || !!props.transcript),
    run: async (_ctx, target: { messageID: string }) => {
      setRevealError(undefined);
      following?.pause();
      await props.transcript?.ensure(target.messageID, revealLifetime.signal);
      const message = projection().messagesByID[target.messageID];
      if (!message) {
        throw new RequestFailure({
          code: "message.missing",
          retry: "none",
          diagnosticID: randomID(),
        });
      }
      const key = replyKey(message), reply = projection().repliesByID[key];
      const ancestors = recordGroups().parents[key] ?? [];
      interaction.reveal(ancestors);
      const focus = () => {
        const control = controls.get(reply?.message.id ?? target.messageID);
        if (!control) {
          throw new RequestFailure({
            code: "message.missing",
            retry: "none",
            diagnosticID: randomID(),
          });
        }
        control.reveal();
      };
      await window?.reveal(recordGroups().owners[key] ?? key, {
        align: "center",
        focus: ancestors.length ? undefined : focus,
      });
      for (let n = 0; n < ancestors.length; n++) {
        const control = recordWindows.get(ancestors[n]);
        if (!control) {
          throw new RequestFailure({
            code: "message.missing",
            retry: "none",
            diagnosticID: randomID(),
          });
        }
        await control.reveal(ancestors[n + 1] ?? key, {
          align: "center",
          focus: n === ancestors.length - 1 ? focus : undefined,
        });
      }
    },
  });
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
  const mountViewport = () => {
    const returnAnchor = props.transcript?.interaction.anchor();
    const lifetime = new AbortController();
    onCleanup(() => lifetime.abort());
    onSettled(() => {
      const clock = setInterval(() => {
        if (props.retryState) setNow(Date.now());
      }, 1000);
      following = followViewport(list, flow);
      let sendRevision = sessionPorts?.delivery?.state.follow;
      const releaseSends = sessionPorts?.delivery?.subscribe(() => {
        const next = sessionPorts.delivery?.state.follow;
        if (next === sendRevision) return;
        sendRevision = next;
        props.transcript?.interaction.anchor(null);
        following?.reset();
      });
      publishHistory();
      setGeometry(following.snapshot());
      const releaseGeometry = following.subscribeSnapshot(setGeometry);
      source = sourceViewport(
        list,
        () => projection().messageIDs,
        (range) => {
          props.transcript?.viewport(range);
          if (range) {
            const ids = projection().messageIDs;
            sessionPorts?.delivery?.presented(
              ids.slice(ids.indexOf(range.first), ids.indexOf(range.last) + 1),
            );
          }
        },
      );
      for (const [element, region] of regions) {
        region.release = source.attach(element, region.id);
      }
      if (returnAnchor?.messageID && props.transcript) {
        const transcript = props.transcript, follower = following;
        void follower.restore((signal) =>
          transcript.ensure(
            returnAnchor.messageID!,
            AbortSignal.any([signal, lifetime.signal]),
          ), async () => {
          lifetime.signal.throwIfAborted();
          follower.pause();
          await window?.restore(returnAnchor);
        }).catch((error) => {
          if (!isCancellation(error)) {
            setRevealError(
              failureValue(error, {
                actionLabel: "Revealing prompt",
                target: {
                  sidecarId: props.sidecarId,
                  sessionID: props.info?.id,
                  label: props.info?.title,
                },
              }),
            );
          }
        });
      }
      return () => {
        clearInterval(clock);
        releaseGeometry();
        releaseSends?.();
        following?.dispose();
        source?.dispose();
        source = undefined;
        regions.clear();
        following = undefined;
        releaseHighlighting?.();
        releaseHighlighting = undefined;
      };
    });
  };
  return (
    <HighlightProvider lease={highlightLease()}>
      <TranscriptContext
        interaction={interaction}
        nativeSource={props.transcript?.nativeSource}
        visibility={attachSource}
      >
        <PathProvider
          paths={sessionPorts?.directoryCatalog?.state.catalog?.paths}
        >
          <section
            class="otk-session-view"
            aria-label="Session"
            aria-busy={transcriptBusy() ? "true" : "false"}
          >
            {props.displayMenu}
            <Show when={props.info?.parentID}>
              <SubagentBar
                info={props.info!}
                siblings={props.siblings}
                onMove={props.transcript
                  ? async (delta) => {
                    const id = await props.transcript!.sibling(delta);
                    if (id) props.onOpenChild(id);
                  }
                  : undefined}
                onOpen={props.onOpenChild}
              />
            </Show>
            <Show when={props.branchHistory?.state.opened}>
              <SavedBranches
                owner={props.branchHistory!}
                prefs={props.prefs}
                onOpenChild={props.onOpenChild}
              />
            </Show>
            <Show when={!props.branchHistory?.state.opened}>
              {(_live) => {
                mountViewport();
                return (
                  <div class="otk-transcript-viewport">
                    <ScrollRegion
                      role="region"
                      aria-label="Transcript"
                      aria-busy={transcriptBusy() ? "true" : "false"}
                      class={[
                        "otk-messages",
                        {
                          "is-empty": !count() &&
                            !sessionPorts?.delivery?.state.receipts.length,
                        },
                      ]}
                      scrollbar={props.prefs.scrollbar ? "otk" : "hidden"}
                      ref={[
                        (element) => {
                          list = element;
                        },
                        contextTarget(() => ({
                          kind: "session",
                          area: true,
                          data: props.info && {
                            sidecarId: props.sidecarId,
                            sessionID: props.info.id,
                            directory: props.info.directory,
                            title: props.info.title,
                          },
                        })),
                      ]}
                    >
                      <Show
                        when={!count() &&
                          !sessionPorts?.delivery?.state.receipts.length &&
                          (props.loading || props.error ||
                            props.continuity === "missing")}
                      >
                        <PaneState
                          feedback={props.error
                            ? {
                              ...errorFeedback(props.error)!,
                              action: {
                                label: "Retry messages",
                                run: () => void retry(),
                              },
                            }
                            : undefined}
                        >
                          <Show when={!props.error}>
                            <ProgressStatus
                              text={props.transcript?.progress
                                ? props.transcript.progress().text
                                : "Loading messages..."}
                            />
                          </Show>
                        </PaneState>
                      </Show>
                      <Show
                        when={!props.loading && !count() && !props.error &&
                          !sessionPorts?.delivery?.state.receipts.length &&
                          !props.sessionError && !props.info?.notices?.length &&
                          props.continuity !== "missing"}
                      >
                        <PaneState>
                          <EmptyState>Start a conversation below.</EmptyState>
                        </PaneState>
                      </Show>
                      <Show
                        when={!!count() &&
                          (props.loading || props.continuity === "missing")}
                      >
                        <ProgressStatus
                          text={props.transcript?.progress
                            ? props.transcript.progress().text
                            : "Loading messages..."}
                        />
                      </Show>
                      <div
                        class="otk-message-flow"
                        data-message-count={count()}
                        ref={(element) => {
                          flow = element;
                        }}
                      >
                        <Show when={props.paging}>
                          <PaneState>
                            <ProgressStatus
                              text={props.transcript?.progress
                                ? props.transcript.progress().text
                                : "Loading earlier messages..."}
                            />
                          </PaneState>
                        </Show>
                        <Show
                          when={!props.exhausted && count() &&
                            !props.paging && !props.loading &&
                            props.continuity !== "missing"}
                        >
                          <button
                            type="button"
                            class="otk-load-older"
                            onClick={() => void older()}
                          >
                            Load older messages
                          </button>
                        </Show>
                        <Show when={props.error && !!count()}>
                          <PaneState
                            feedback={{
                              ...errorFeedback(props.error)!,
                              action: {
                                label: "Retry messages",
                                run: () => void retry(),
                              },
                            }}
                          />
                        </Show>
                        <Show when={revealError()}>
                          <PaneState feedback={errorFeedback(revealError())} />
                        </Show>
                        <SessionError
                          state={props.errorState}
                          error={props.sessionError}
                          target={failureTarget()}
                          operationKey={feedback()?.identity}
                          diagnosticID={feedback()?.diagnosticID}
                          composer={feedback()}
                          onReveal={(messageID) =>
                            void reveal({ messageID }).catch((cause) =>
                              setRevealError(failureValue(cause))
                            )}
                        />
                        <For each={props.info?.notices}>
                          {(failure) => (
                            <FeedbackStatus
                              class="otk-session-notice"
                              singleLine
                              feedback={placeFailure(
                                contextualFailure(failure, {
                                  target: failureTarget(),
                                }),
                                { surface: "session", view: failureTarget() },
                              )}
                            />
                          )}
                        </For>
                        <Show when={props.retryState}>
                          {(retry) => (
                            <div class="otk-retry-banner" role="status">
                              <strong>
                                Retrying · attempt {retry().attempt}
                              </strong>
                              <p title={retry().message}>{retry().message}</p>
                              <span>
                                Next attempt in {Math.max(
                                  0,
                                  Math.ceil((retry().next - now()) / 1000),
                                )}s
                              </span>
                            </div>
                          )}
                        </Show>
                        <Show
                          when={!props.transcript ||
                            props.transcript.state.temperature === "screen"}
                        >
                          {(_screen) => {
                            const positionAnchor = props.transcript?.interaction
                              .anchor();
                            return (
                              <VirtualList
                                keys={recordGroups().keys}
                                revision={recordGroups().revision}
                                measurementKey={(key) =>
                                  `${key}:${
                                    recordGroups().revisions[key] ?? 0
                                  }`}
                                label="Transcript messages"
                                viewport={() => list}
                                samples={[{
                                  role: "reply",
                                  class: "otk-window-reply-estimate",
                                }]}
                                role={() => "reply"}
                                overscan={0}
                                retainExcluded={false}
                                measurements={props.transcript?.interaction
                                  .measurements}
                                control={(control) => {
                                  window = control;
                                }}
                                position={positionAnchor
                                  ? {
                                    scrollTop: 0,
                                    anchor: positionAnchor,
                                  }
                                  : undefined}
                                onPosition={(position) => {
                                  followIntent = following?.following() ??
                                    followIntent;
                                  if (followIntent) {
                                    props.transcript?.interaction.anchor(null);
                                    return;
                                  }
                                  if (position.anchor) {
                                    props.transcript?.interaction.anchor(
                                      {
                                        ...position.anchor,
                                        messageID: projection()
                                          .repliesByID[
                                            recordGroups()
                                              .groups[position.anchor.key]
                                              ?.members[0] ??
                                              position.anchor.key
                                          ]
                                          ?.messageIDs[0],
                                      },
                                    );
                                  }
                                }}
                                onPins={(keys) =>
                                  props.transcript?.pin(
                                    keys.flatMap((key) =>
                                      (recordGroups().groups[key]?.members ??
                                        [key])
                                        .flatMap((member) =>
                                          projection().repliesByID[member]
                                            ?.messageIDs ?? []
                                        )
                                    ),
                                  )}
                                render={(key) =>
                                  renderGroup(
                                    key,
                                    (key) => (
                                      <Show
                                        when={projection().repliesByID[key]}
                                      >
                                        {(reply) => {
                                          const message = () => reply().message;
                                          const turnID = () =>
                                            message().role === "assistant"
                                              ? (message() as import("@otk/protocol").AssistantMessage)
                                                .replyTo ?? message().id
                                              : message().id;
                                          const target = () => ({
                                            sidecarId: props.sidecarId!,
                                            sessionID: message().sessionID,
                                            turnID: turnID(),
                                          });
                                          return (
                                            <Message
                                              sidecarId={props.sidecarId}
                                              sessionTitle={props.entry
                                                ?.title ??
                                                props.info?.title}
                                              ownerID={reply().key}
                                              segments={reply().segments}
                                              message={message()}
                                              lastID={reply().lastID}
                                              pending={reply().pending}
                                              recovery={props.transcript?.state
                                                .content
                                                .recovering
                                                ?.find((
                                                  p,
                                                ) =>
                                                  reply().messageIDs.includes(
                                                    p.messageID,
                                                  )
                                                )
                                                ?.state ??
                                                (props.transcript?.state
                                                    .recovering
                                                    .some((
                                                      p,
                                                    ) =>
                                                      reply().messageIDs
                                                        .includes(
                                                          p.messageID,
                                                        )
                                                    )
                                                  ? "recovering"
                                                  : undefined)}
                                              onRetryRecovery={() =>
                                                void retry()}
                                              usage={props.usageOwner?.priced(
                                                target(),
                                                props.catalog,
                                              )}
                                              summary={sessionResult(
                                                props.entry,
                                                message(),
                                              )}
                                              openUsage={props.openUsage
                                                ? () =>
                                                  props.openUsage!(turnID())
                                                : undefined}
                                              usageError={() =>
                                                props.usageError?.(turnID())}
                                              copySource={props.transcript
                                                ? (id, text) =>
                                                  props.transcript!.source(
                                                    id,
                                                    text,
                                                  )
                                                : undefined}
                                              activeRecord={progressRecord() ===
                                                message().id}
                                              copyIncomplete={message().role ===
                                                  "assistant" &&
                                                !!props.transcript &&
                                                (!props.exhausted &&
                                                  (!props.transcript.projection
                                                    .boundary(
                                                      turnID(),
                                                    )
                                                    ?.firstID ||
                                                    !projection()
                                                      .messagesByID[
                                                        reply().firstID
                                                      ]))}
                                              prefs={props.prefs}
                                              directory={props.info?.directory}
                                              permissions={props.permissions}
                                              onOpenChild={props.onOpenChild}
                                              queued={projection().queuedIDs
                                                .has(
                                                  message().id,
                                                )}
                                              control={(control) => {
                                                const id = message().id;
                                                controls.set(id, control);
                                                return () => {
                                                  if (
                                                    controls.get(id) === control
                                                  ) {
                                                    controls
                                                      .delete(id);
                                                  }
                                                };
                                              }}
                                            />
                                          );
                                        }}
                                      </Show>
                                    ),
                                  )}
                              />
                            );
                          }}
                        </Show>
                        <MessageDelivery owner={sessionPorts?.delivery} />
                      </div>
                    </ScrollRegion>
                    <JumpToLatest
                      visible={!!geometry() &&
                        (geometry()!.newMessages ||
                          geometry()!.distanceFromBottom >
                            geometry()!.viewportHeight)}
                      newMessages={geometry()?.newMessages}
                      title={hints.title("transcript.latest", "Jump to latest")}
                      onJump={() => {
                        void latest().catch((error) => {
                          if (!isCancellation(error)) {
                            setRevealError(failureValue(error, {
                              actionLabel: "Revealing latest messages",
                              target: {
                                sidecarId: props.sidecarId,
                                sessionID: props.info?.id,
                                label: props.info?.title,
                              },
                            }));
                          }
                        });
                      }}
                    />
                  </div>
                );
              }}
            </Show>
            <ComposerTakeovers
              focusNotice={() => noticeControl?.focus()}
              notice={noticed() ? notice : undefined}
              readOnly={props.child}
            >
              {(active) => (
                <div
                  class={["otk-composer-stack", {}]}
                  inert={active()}
                >
                  <div
                    class={["otk-composer-input", {}]}
                  >
                    <Prompt
                      suspended={active()}
                      context={props.latestPrompt}
                      busy={props.busy}
                      value={props.draft}
                      connected={props.connected}
                      onChange={writeDraft}
                      onSubmit={(parts, mode, selection) =>
                        props.onPrompt(parts, mode, selection)}
                      onAbort={() => props.onAbort()}
                    />
                  </div>
                </div>
              )}
            </ComposerTakeovers>
          </section>
        </PathProvider>
      </TranscriptContext>
    </HighlightProvider>
  );
}
