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
import RecordKinds from "./RecordKinds.tsx";
import { recordKindDisclosure, remaining } from "@otk/client";
import TimeText from "./TimeText.tsx";
import { activeProgressRecord } from "./work-log.ts";
import { PathProvider } from "./PathProvider.tsx";
import Prompt from "./Prompt.tsx";
import ComposerTakeovers from "./ComposerTakeovers.tsx";
import type { Preferences } from "@otk/protocol";
import SubagentBar from "./SubagentBar.tsx";
import RevertGroup, { RevertConfirmation } from "./RevertGroup.tsx";
import SavedBranches, {
  RevertSendChoice,
  SavedBranchNotice,
} from "./SavedBranches.tsx";
import { ForkFact } from "./ForkNote.tsx";
import ComposerNotice, { ComposerActionNotice } from "./ComposerNotice.tsx";
import OperationFeedback from "./OperationFeedback.tsx";
import PaneState from "./PaneState.tsx";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { bindFeedback } from "../state/feedback.ts";
import { useSessionPorts } from "../registries/session.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import SessionError from "./SessionError.tsx";
import type { SessionErrorState } from "@otk/protocol";
import {
  contextualFailure,
  createRevertRecordProjection,
  createTranscriptInteraction,
  createTranscriptProjection,
  errorFeedback,
  type FailureValue,
  failureValue,
  placeFailure,
  replyKey,
  RequestFailure,
  revertFlowBoundary,
  revertPresentation,
  revertRecordKey,
  savedBranchMatches,
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
import TranscriptGap from "./TranscriptGap.tsx";
import { activityRecord } from "./activity-record.ts";
/** Acquisition status for the host's fixed status slot, never the message flow. */
export function transcriptStatus(input: {
  loading?: boolean;
  paging?: boolean;
  continuity?: string;
  transcript?: TranscriptOwner;
}): string {
  if (
    input.loading || input.paging || input.continuity === "missing" ||
    input.transcript?.state.load?.state === "loading"
  ) {
    return input.transcript?.progress?.().text ||
      (input.paging ? "Loading earlier messages..." : "Loading messages...");
  }
  return "";
}
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
  onMoveSibling?(delta: number): void | Promise<void>;
  onOpenChild(id: string): void;
  child: boolean;
  revert: RevertInfo | null;
  rollback?: import("@otk/client").SessionRevert;
  branchHistory?: import("@otk/client").BranchHistory;
  strip?: import("@otk/client").RevertStrip;
  busy: boolean;
  retryState?: { attempt: number; message?: string; next?: number };
  mountTranscriptLayer?(stage: HTMLDivElement): () => void;
  onOlder(): Promise<void>;
  onRetry(): Promise<void>;
  onDraft(value: DraftChange): Draft;
  captureSend?: PromptProps["captureSend"];
  draftRecoveries?: readonly import("@otk/client").DraftRecovery[];
  onPrompt: PromptProps["onSubmit"];
  activity: PromptProps["activity"];
  onStop: PromptProps["onStop"];
}): Element {
  let releaseTranscriptLayer: (() => void) | undefined;
  onCleanup(() => releaseTranscriptLayer?.());
  const writeDraft = props.onDraft;
  const sessionPorts = useSessionPorts();
  const { composerDocks } = useUiRegistries();
  const feedbackOwner = sessionPorts?.feedback;
  const requestFeedback = bindFeedback(() => feedbackOwner);
  const rollbackPresentation = createMemo(() =>
    revertPresentation(
      props.rollback?.state ?? {},
      requestFeedback(),
      props.branchHistory?.state,
    )
  );
  const failureTarget = () => ({
    sidecarId: props.sidecarId,
    sessionID: props.info?.id,
    label: props.info?.title,
  });
  let noticeControl: { focus(): void } | undefined;
  const [activationNotice, setActivationNotice] = createSignal<string>();
  const revealLifetime = new AbortController();
  onCleanup(() => revealLifetime.abort());
  const highlightLease = createMemo(() =>
    props.transcript ? transcriptHighlightLease(props.transcript) : undefined
  );
  // The selected facade can release its resource before this view and its
  // commands unmount. Keep the compatibility projection valid independently.
  const fallbackProjection = createTranscriptProjection();
  const fallback = createMemo(() => {
    fallbackProjection.reset(props.messages ?? []);
    fallbackProjection.busy(props.busy);
    return fallbackProjection.state;
  });
  const interaction = props.transcript?.interaction ??
    createTranscriptInteraction();
  const projection = () => props.transcript?.state ?? fallback();
  const messageIDs = createMemo(() => new Set(projection().messageIDs));
  const hasRecord = (id: string) => messageIDs().has(id);
  const feedback = createMemo(() =>
    sessionComposerFeedback(
      props.errorState,
      failureTarget(),
      rollbackPresentation().feedback,
      hasRecord,
    )
  );
  const rollbackState = () => rollbackPresentation().state;
  const revertRecords = createRevertRecordProjection();
  const displayedRecords = createMemo(() =>
    revertRecords(projection(), rollbackState())
  );
  const recordGroups = () => displayedRecords();
  const logCompletion = (key: string) => {
    const group = recordGroups().groups[recordGroups().completions[key]];
    return group?.silent ? group : undefined;
  };
  const transcriptKeys = createMemo(() =>
    recordGroups().keys.filter((key) => {
      const group = recordGroups().groups[key];
      return !(group?.silent && group.completionOf);
    })
  );
  const isRevert = (key: string) => {
    const boundary = revertFlowBoundary(rollbackState());
    return boundary && key === revertRecordKey(boundary);
  };
  const recordWindows = new Map<string, VirtualListControl>();
  const recordWindow = (key: string, control: VirtualListControl) => {
    recordWindows.set(key, control);
    return () => {
      if (recordWindows.get(key) === control) recordWindows.delete(key);
    };
  };
  const renderRecords = (
    group: () => import("@otk/client").ActivityGroup,
    one: (key: string) => Element,
    children = () => group().children ?? [],
  ): Element => (
    <RecordList
      items={children()}
      key={(child) => child.key}
      scope={group().key}
      control={(control) => recordWindow(group().key, control)}
      revision={(child) => child.revision}
      outgoing={group().direction === "outgoing"}
      outgoingItem={(child) => child.direction === "outgoing"}
      render={(child) =>
        activityRecord(child, one, () => (
          <ActivityGroup
            group={child()}
            onOpenChild={props.onOpenChild}
            prefs={props.prefs}
            body={() => (
              <RecordList
                items={child().members}
                key={(key) => key}
                scope={child().key}
                control={(control) => recordWindow(child().key, control)}
                revision={(key) => projection().repliesByID[key]?.revision ?? 0}
                outgoing={child().direction === "outgoing"}
                render={(key) => one(key())}
              />
            )}
          />
        ))}
    />
  );
  const gapKey = (key: string) => key.startsWith("gap:");
  const gaps = () => props.transcript?.state.gaps;
  const renderGroup = (key: string, one: (key: string) => Element) =>
    gapKey(key)
      ? (
        <Show when={gaps()?.find((gap) => gap.key === key)}>
          {(gap) => (
            <TranscriptGap
              gap={gap}
              onLoad={() => void props.transcript?.bridge(key)}
            />
          )}
        </Show>
      )
      : renderRecord(key, one);
  const renderRecord = (key: string, one: (key: string) => Element) => (
    <Show
      when={isRevert(key)}
      fallback={
        <Show when={recordGroups().groups[key]} fallback={one(key)}>
          {(group) => (
            <RecordKinds
              items={group().children ?? []}
              identity={group().key}
              count={(child) => child.members.length}
              prefs={props.prefs}
              activity={(child) => {
                const reply = projection().repliesByID[child.members[0]];
                const part = reply?.message.parts[0];
                return reply?.message.parts.length === 1 && !reply.pending &&
                    part?.kind === "external" &&
                    !part.failure
                  ? part.activity
                  : undefined;
              }}
              render={(visible, meta) => (
                <ActivityGroup
                  group={group()}
                  onOpenChild={props.onOpenChild}
                  prefs={props.prefs}
                  meta={meta}
                  breakouts={() => (
                    <RecordList
                      items={group().breakouts ?? []}
                      key={(id) => id}
                      scope={group().key}
                      control={(control) => recordWindow(group().key, control)}
                      revision={(id) =>
                        projection().repliesByID[id]?.revision ?? 0}
                      outgoing={group().direction === "outgoing"}
                      render={(id) => one(id())}
                    />
                  )}
                  body={() => renderRecords(group, one, visible)}
                />
              )}
            />
          )}
        </Show>
      }
    >
      <RevertGroup
        group={recordGroups().groups[key]}
        state={rollbackState()}
        owner={props.rollback}
        history={props.branchHistory}
        prefs={props.prefs}
        target={props.info && props.sidecarId
          ? {
            sidecarId: props.sidecarId,
            sessionID: props.info.id,
            directory: props.info.directory,
            title: props.info.title,
          }
          : undefined}
        warning={props.branchHistory?.preservationWarning()}
        failure={rollbackPresentation().recordFailure?.failure}
        failureStatus={rollbackPresentation().recordStatus}
        recoverCopy={rollbackPresentation().recordRecovery}
        onOpenCopy={props.branchHistory && rollbackState().record
          ? () => {
            const branch = props.branchHistory!.state.branches.find((branch) =>
              savedBranchMatches(branch, rollbackState().record!)
            );
            if (branch) props.branchHistory!.open(branch.id);
          }
          : undefined}
        onOpenChild={props.onOpenChild}
      />
    </Show>
  );
  const count = () => projection().messageIDs.length;
  // One in-flow progress per active turn: an unfinished reply owns it;
  // otherwise the turn's newest active native record does.
  const progressRecord = createMemo(() => activeProgressRecord(projection()));
  const transcriptBusy = () =>
    props.loading || props.paging ||
    props.continuity === "loading" || props.continuity === "missing";
  const noticed = () =>
    !!props.forkNote || !!feedback() || !!activationNotice() ||
    !!props.draftRecoveries?.length ||
    !!props.branchHistory?.state.permanence ||
    rollbackPresentation().noticeRecovery ||
    !!props.branchHistory?.state.choice ||
    !!rollbackPresentation().branchFeedback;
  // The slot's identity is its mounted lifetime, not each feedback publication.
  const notice = () => (
    <ComposerNotice>
      <Show when={props.branchHistory}>
        {(owner) => (
          <>
            <RevertSendChoice
              owner={owner()}
              feedback={rollbackPresentation().permanenceFeedback}
            />
            <SavedBranchNotice
              owner={owner()}
              feedback={rollbackPresentation().branchFeedback}
              recoveryVisible={rollbackPresentation().noticeRecovery}
              statusVisible={false}
            />
          </>
        )}
      </Show>
      <Show when={activationNotice()}>
        {(text) => <ComposerActionNotice text={text()} />}
      </Show>
      <Show
        when={feedback()?.kind !== "pending" || !activationNotice()
          ? feedback()
          : undefined}
      >
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
      <For each={props.draftRecoveries}>
        {(recovery) => (
          <OperationFeedback
            feedback={{
              kind: "info",
              text: recovery.cause === "stop-unconfirmed"
                ? "Couldn't confirm the stop; your message is kept."
                : recovery.kind === "uncertain"
                ? "Send not confirmed. The submitted draft is kept separately."
                : `${
                  recovery.cause === "withdrawn"
                    ? "Stopped before it started. "
                    : ""
                }Draft kept separately: ${
                  recovery.draft.input.trim() ||
                  recovery.draft.chips.map((chip) => chip.label).join(", ") ||
                  "Empty draft"
                }`,
              action: {
                label: recovery.kind === "uncertain"
                  ? "Check send"
                  : "Recover draft",
                run: recovery.run,
              },
            }}
          />
        )}
      </For>
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
  createEffect(() => ({
    boundary: revertFlowBoundary(rollbackState()),
    phase: rollbackState().phase,
  }), (next, previous) => {
    if (
      !next.boundary || next.phase === "confirming" ||
      next.boundary === previous?.boundary && previous.phase !== "confirming"
    ) return;
    onSettled(() => {
      void window?.reveal(revertRecordKey(next.boundary!), { align: "nearest" })
        .catch((cause) => {
          if (!isCancellation(cause)) {
            setRevealError(failureValue(cause, {
              actionLabel: "Revealing the staged revert",
              target: failureTarget(),
              reason: "The reverted messages could not be brought into view.",
              recovery:
                "Use Jump to latest to see the revert and its Restore action.",
            }));
          }
        });
    });
  });
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
      await props.transcript?.ensure(target.messageID, revealLifetime.signal);
      const message = projection().messagesByID[target.messageID];
      if (!message) {
        throw new RequestFailure({
          code: "message.missing",
          retry: "none",
          diagnosticID: randomID(),
        });
      }
      const reply = props.transcript?.projection.entry(message.id) ??
        projection().repliesByID[replyKey(message)];
      const key = reply?.key ?? replyKey(message);
      const ancestors = recordGroups().parents[key] ?? [];
      const part = message.parts[0];
      const recordOwner = recordGroups().owners[key];
      const interval = recordGroups().groups[recordOwner];
      const completionOf = interval?.silent ? interval.completionOf : undefined;
      if (completionOf) {
        const replyID = projection().repliesByID[completionOf]?.message.id;
        await window?.reveal(completionOf, {
          align: "center",
          intent: "user",
          focus: replyID ? () => controls.get(replyID)?.reveal() : undefined,
        });
        return;
      }
      if (recordOwner && part?.kind === "external" && part.activity?.fold) {
        recordKindDisclosure(interaction, recordOwner, part.activity.category)
          .set(true);
      }
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
      await window?.reveal(recordOwner ?? key, {
        align: "center",
        intent: "user",
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
        await control.reveal(
          ancestors[n + 1] ?? recordGroups().leaves[key] ?? key,
          {
            align: "center",
            intent: "user",
            focus: n === ancestors.length - 1 ? focus : undefined,
          },
        );
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
            <Show
              when={props.info?.parentID &&
                (props.transcript || props.onMoveSibling)}
            >
              <SubagentBar
                available={props.siblings.length > 1}
                onMove={async (delta) => {
                  if (!props.transcript) return props.onMoveSibling?.(delta);
                  const id = await props.transcript.sibling(delta);
                  if (id) props.onOpenChild(id);
                }}
              />
            </Show>
            <div class="otk-session-content">
              <div
                class={["otk-transcript-stage", {
                  "has-notification-layer": !!props.mountTranscriptLayer,
                }]}
                ref={(element) => {
                  releaseTranscriptLayer = props.mountTranscriptLayer?.(
                    element,
                  );
                }}
              >
                <Show when={props.branchHistory?.state.opened}>
                  <div class="otk-transcript-viewport">
                    <SavedBranches
                      owner={props.branchHistory!}
                      prefs={props.prefs}
                      onOpenChild={props.onOpenChild}
                    />
                  </div>
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
                                !revertFlowBoundary(rollbackState()) &&
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
                              props.error}
                          >
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
                          <Show
                            when={!props.loading && !count() &&
                              !revertFlowBoundary(rollbackState()) &&
                              !props.error &&
                              !sessionPorts?.delivery?.state.receipts.length &&
                              !props.sessionError &&
                              !props.info?.notices?.length &&
                              props.continuity !== "missing"}
                          >
                            <PaneState>
                              <EmptyState>
                                Start a conversation below.
                              </EmptyState>
                            </PaneState>
                          </Show>
                          <div
                            class="otk-message-flow"
                            data-message-count={count()}
                            ref={(element) => {
                              flow = element;
                            }}
                          >
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
                            <Show
                              when={props.error && !!count() &&
                                !gaps()?.some((gap) =>
                                  gap.failure === props.error
                                )}
                            >
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
                              <PaneState
                                feedback={errorFeedback(revealError())}
                              />
                            </Show>
                            <SessionError
                              state={props.errorState}
                              error={props.sessionError}
                              target={failureTarget()}
                              operationKey={feedback()?.identity}
                              diagnosticID={feedback()?.diagnosticID}
                              composer={feedback()}
                              hasRecord={hasRecord}
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
                                    {
                                      surface: "session",
                                      view: failureTarget(),
                                      hasRecord,
                                    },
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
                                  <Show when={retry().message}>
                                    {(message) => (
                                      <p title={message()}>{message()}</p>
                                    )}
                                  </Show>
                                  <Show when={retry().next !== undefined}>
                                    <span>
                                      Next attempt in{" "}
                                      <TimeText
                                        time={remaining(
                                          retry().next! - now(),
                                          "second",
                                        )}
                                      />
                                    </span>
                                  </Show>
                                </div>
                              )}
                            </Show>
                            <Show
                              when={!props.transcript ||
                                props.transcript.state.temperature === "screen"}
                            >
                              {(_screen) => {
                                const positionAnchor = props.transcript
                                  ?.interaction
                                  .anchor();
                                return (
                                  <VirtualList
                                    keys={transcriptKeys()}
                                    revision={recordGroups().revision}
                                    anchorable={(key) => !gapKey(key)}
                                    measurementKey={(key) =>
                                      gapKey(key)
                                        ? key
                                        : `${key}:${
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
                                        props.transcript?.interaction.anchor(
                                          null,
                                        );
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
                                          (recordGroups().groups[key]
                                            ?.members ??
                                            [
                                              key,
                                              ...(logCompletion(key)?.members ??
                                                []),
                                            ])
                                            .flatMap((member) =>
                                              projection().repliesByID[member]
                                                ?.messageIDs ?? []
                                            )
                                        ),
                                      )}
                                    render={(key) =>
                                      renderGroup(
                                        key,
                                        function renderReply(key): Element {
                                          return (
                                            <Show
                                              when={projection()
                                                .repliesByID[key]}
                                            >
                                              {(reply) => {
                                                const message = () =>
                                                  reply().message;
                                                const turnID = () =>
                                                  message().role === "assistant"
                                                    ? (message() as import("@otk/protocol").AssistantMessage)
                                                      .replyTo ?? message().id
                                                    : message().id;
                                                const target = () => ({
                                                  sidecarId: props.sidecarId!,
                                                  sessionID:
                                                    message().sessionID,
                                                  turnID: turnID(),
                                                });
                                                return (
                                                  <>
                                                    <Message
                                                      sidecarId={props
                                                        .sidecarId}
                                                      sessionTitle={props.entry
                                                        ?.title ??
                                                        props.info?.title}
                                                      ownerID={reply().key}
                                                      segments={reply()
                                                        .segments}
                                                      message={message()}
                                                      send={reply().send}
                                                      sourceTime={(id) =>
                                                        projection()
                                                          .messagesByID[id]
                                                          ?.time.created}
                                                      sourceOutcomeTime={(
                                                        id,
                                                      ) => {
                                                        const source =
                                                          projection()
                                                            .messagesByID[id];
                                                        return source?.role !==
                                                            "user"
                                                          ? source?.outcomeTime
                                                          : undefined;
                                                      }}
                                                      lastID={reply().lastID}
                                                      pending={reply().pending}
                                                      recovery={props.transcript
                                                        ?.state
                                                        .content
                                                        .recovering
                                                        ?.find((
                                                          p,
                                                        ) =>
                                                          reply().messageIDs
                                                            .includes(
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
                                                      usage={props.usageOwner
                                                        ?.priced(
                                                          target(),
                                                          props.catalog,
                                                        )}
                                                      summary={sessionResult(
                                                        props.entry,
                                                        message(),
                                                      )}
                                                      openUsage={props.openUsage
                                                        ? () =>
                                                          props.openUsage!(
                                                            turnID(),
                                                          )
                                                        : undefined}
                                                      usageError={() =>
                                                        props.usageError?.(
                                                          turnID(),
                                                        )}
                                                      copySource={props
                                                          .transcript
                                                        ? (id, text) =>
                                                          props.transcript!
                                                            .source(
                                                              id,
                                                              text,
                                                            )
                                                        : undefined}
                                                      activeRecord={progressRecord() ===
                                                        message().id}
                                                      copyIncomplete={message()
                                                            .role ===
                                                          "assistant" &&
                                                        !!props.transcript &&
                                                        (!props.exhausted &&
                                                          (!props.transcript
                                                            .projection
                                                            .boundary(
                                                              turnID(),
                                                            )
                                                            ?.firstID ||
                                                            !projection()
                                                              .messagesByID[
                                                                reply().firstID
                                                              ]))}
                                                      prefs={props.prefs}
                                                      directory={props.info
                                                        ?.directory}
                                                      permissions={props
                                                        .permissions}
                                                      onOpenChild={props
                                                        .onOpenChild}
                                                      queued={projection()
                                                        .queuedIDs
                                                        .has(
                                                          message().id,
                                                        )}
                                                      control={(control) => {
                                                        const id = message().id;
                                                        controls.set(
                                                          id,
                                                          control,
                                                        );
                                                        return () => {
                                                          if (
                                                            controls.get(id) ===
                                                              control
                                                          ) {
                                                            controls
                                                              .delete(id);
                                                          }
                                                        };
                                                      }}
                                                    />
                                                    <Show
                                                      when={props.rollback &&
                                                        rollbackState()
                                                            .confirmation
                                                            ?.messageID ===
                                                          message().id &&
                                                        (rollbackState()
                                                              .phase ===
                                                            "confirming" ||
                                                          rollbackState()
                                                                  .phase ===
                                                                "failed" &&
                                                            !rollbackState()
                                                              .record)}
                                                    >
                                                      <RevertConfirmation
                                                        owner={props.rollback!}
                                                      />
                                                    </Show>
                                                  </>
                                                );
                                              }}
                                            </Show>
                                          );
                                        },
                                      )}
                                  />
                                );
                              }}
                            </Show>
                            <MessageDelivery
                              owner={sessionPorts?.delivery}
                              class="otk-transcript-delivery"
                            />
                          </div>
                        </ScrollRegion>
                        <JumpToLatest
                          visible={!!geometry() &&
                            (geometry()!.newMessages ||
                              geometry()!.distanceFromBottom >
                                geometry()!.viewportHeight)}
                          newMessages={geometry()?.newMessages}
                          title={hints.title(
                            "transcript.latest",
                            "Jump to latest",
                          )}
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
              </div>
              <div class="otk-session-docks">
                <For
                  each={composerDocks.available(sessionPorts.supports)}
                  keyed={(dock) => dock.id}
                >
                  {(dock) => dock().component()}
                </For>
              </div>
            </div>
            <ComposerTakeovers
              focusNotice={() => noticeControl?.focus()}
              notice={noticed() ? notice : undefined}
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
                      joinRequired={props.child}
                      suspended={active()}
                      context={props.latestPrompt}
                      activity={props.activity}
                      value={props.draft}
                      connected={props.connected}
                      onChange={writeDraft}
                      captureSend={props.captureSend}
                      onSubmit={props.onPrompt}
                      onStop={props.onStop}
                      onActivationNotice={setActivationNotice}
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
