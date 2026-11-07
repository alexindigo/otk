// SPDX-License-Identifier: LGPL-3.0-only
import { EmptyState } from "./View.tsx";
import "./SessionView.css" with { type: "text" };
import { scrollRegion } from "./ScrollRegion.tsx";
import { isCancellation } from "@otk/protocol";
import {
  createEffect,
  createMemo,
  createSignal,
  type Element,
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
import { PathProvider } from "./PathProvider.tsx";
import Prompt from "./Prompt.tsx";
import ComposerTakeovers from "./ComposerTakeovers.tsx";
import type { Preferences } from "@otk/protocol";
import SubagentBar from "./SubagentBar.tsx";
import { RolledBackContent } from "./RolledBackStrip.tsx";
import { ForkFact } from "./ForkNote.tsx";
import ComposerNotice from "./ComposerNotice.tsx";
import OperationFeedback from "./OperationFeedback.tsx";
import PaneState from "./PaneState.tsx";
import ProgressStatus from "./ProgressStatus.tsx";
import { bindFeedback } from "../state/feedback.ts";
import { useSessionPorts } from "../registries/session.tsx";
import SessionError from "./SessionError.tsx";
import type { SessionErrorState } from "@otk/protocol";
import {
  createTranscriptProjection,
  failureText,
  sessionSummary,
  type SessionUsageOwner,
  type TranscriptOwner,
} from "@otk/client";
import { followViewport, sourceViewport } from "./viewport.ts";
import { highlightingScope } from "../highlight/client.ts";
import {
  HighlightProvider,
  transcriptHighlightLease,
} from "../highlight/context.tsx";
import type { Draft, DraftChange } from "./prompt/model.ts";
import type { PromptProps } from "../registries/prompt.ts";
import {
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
  usageError?(turnID: string): string | undefined;
  loading: boolean;
  continuity?: "loading" | "ready" | "missing";
  paging: boolean;
  exhausted: boolean;
  error?: string;
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
  const feedback = bindFeedback(() => feedbackOwner);
  let noticeControl: { focus(): void } | undefined;
  const returnAnchor = props.transcript?.interaction.anchor();
  const revealLifetime = new AbortController();
  onCleanup(() => revealLifetime.abort());
  const highlightLease = createMemo(() =>
    props.transcript ? transcriptHighlightLease(props.transcript) : undefined
  );
  const fallback = createMemo(() => {
    if (props.transcript) return;
    const projection = createTranscriptProjection();
    projection.replace(props.messages ?? []);
    projection.busy(props.busy);
    return projection.state;
  });
  const projection = () => props.transcript?.state ?? fallback()!;
  const count = () => projection().messageIDs.length;
  const transcriptBusy = () =>
    props.loading || props.paging ||
    props.continuity === "loading" || props.continuity === "missing";
  const rollbackNotice = () =>
    !!props.strip || !!props.rollback?.state.pending ||
    !!props.rollback?.state.error;
  const rollbackState = () => {
    const state = props.rollback?.state ?? {}, shown = feedback();
    const sameRequest = shown?.identity && state.key === shown.identity;
    const sameFailure = shown?.diagnosticID &&
      state.failure?.diagnosticID === shown.diagnosticID;
    return sameRequest || sameFailure
      ? { ...state, pending: undefined, error: undefined }
      : state;
  };
  const noticed = () => rollbackNotice() || !!props.forkNote || !!feedback();
  // The slot's identity is its mounted lifetime, not each feedback publication.
  const notice = () => (
    <ComposerNotice>
      <Show when={feedback()}>
        {(value) => (
          <OperationFeedback
            feedback={value()}
            control={(control) => noticeControl = control}
          />
        )}
      </Show>
      <Show when={rollbackNotice()}>
        <RolledBackContent strip={props.strip} state={rollbackState()} />
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
  const [revealError, setRevealError] = createSignal<string>();
  const older = ownedAction("session.page", () => props.onOlder());
  const retry = ownedAction("session.refetch", () => {
    setRevealError(undefined);
    return props.onRetry();
  });
  let list!: HTMLDivElement, flow!: HTMLDivElement;
  let following: ReturnType<typeof followViewport> | undefined;
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
  ownedCommand(useCommandPorts(), {
    id: "transcript.reveal",
    title: "Reveal prompt",
    category: "Transcript",
    hidden: true,
    enabled: (_ctx, target?: { messageID: string }) =>
      !!target && !!projection().messagesByID[target.messageID],
    run: async (_ctx, target: { messageID: string }) => {
      setRevealError(undefined);
      following?.pause();
      await props.transcript?.ensure(target.messageID, revealLifetime.signal);
      await window?.reveal(target.messageID, {
        align: "center",
        focus: () => {
          const control = controls.get(target.messageID);
          if (!control) throw new Error("Prompt is no longer available");
          control.reveal();
        },
      });
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
  onSettled(() => {
    const clock = setInterval(() => {
      if (props.retryState) setNow(Date.now());
    }, 1000);
    following = followViewport(list, flow);
    source = sourceViewport(
      list,
      () => projection().messageIDs,
      (range) => props.transcript?.viewport(range),
    );
    for (const [element, region] of regions) {
      region.release = source.attach(element, region.id);
    }
    if (returnAnchor?.messageID && props.transcript) {
      void props.transcript.ensure(
        returnAnchor.messageID,
        revealLifetime.signal,
      ).then(async () => {
        revealLifetime.signal.throwIfAborted();
        following?.pause();
        await window?.restore(returnAnchor);
      }).catch((error) => {
        if (!isCancellation(error)) {
          setRevealError(failureText(error));
        }
      });
    }
    return () => {
      clearInterval(clock);
      following?.dispose();
      source?.dispose();
      source = undefined;
      regions.clear();
      following = undefined;
      releaseHighlighting?.();
      releaseHighlighting = undefined;
    };
  });
  return (
    <HighlightProvider lease={highlightLease()}>
      <TranscriptContext
        interaction={props.transcript?.interaction}
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
            <div
              role="region"
              aria-label="Transcript"
              aria-busy={transcriptBusy() ? "true" : "false"}
              class={[scrollRegion(), "otk-messages", {
                "otk-scrollbar-hidden": !props.prefs.scrollbar,
                "is-empty": !count(),
              }]}
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
                  (props.loading || props.error ||
                    props.continuity === "missing")}
              >
                <PaneState
                  feedback={props.error
                    ? {
                      kind: "error",
                      text: props.error,
                      action: {
                        label: "Retry messages",
                        run: () => void retry(),
                      },
                    }
                    : undefined}
                >
                  <Show when={!props.error}>
                    <ProgressStatus
                      text={props.transcript?.progress?.().text ||
                        "Loading messages..."}
                    />
                  </Show>
                </PaneState>
              </Show>
              <Show
                when={!props.loading && !count() && !props.error &&
                  !props.sessionError && props.continuity !== "missing"}
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
                  text={props.transcript?.progress?.().text ||
                    "Loading messages..."}
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
                      text={props.transcript?.progress?.().text ||
                        "Loading earlier messages..."}
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
                      kind: "error",
                      text: props.error!,
                      action: {
                        label: "Retry messages",
                        run: () => void retry(),
                      },
                    }}
                  />
                </Show>
                <Show when={revealError()}>
                  <p role="alert" class="otk-error">{revealError()}</p>
                </Show>
                <SessionError
                  state={props.errorState}
                  error={props.sessionError}
                  operationKey={feedback()?.identity}
                  diagnosticID={feedback()?.diagnosticID}
                />
                <Show when={props.retryState}>
                  {(retry) => (
                    <div class="otk-retry-banner" role="status">
                      <strong>Retrying · attempt {retry().attempt}</strong>
                      <p>Waiting for the agent to retry</p>
                      <span>
                        Next attempt in{" "}
                        {Math.max(0, Math.ceil((retry().next - now()) / 1000))}s
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
                        keys={projection().replyIDs}
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
                          followIntent = following?.following() ?? followIntent;
                          if (followIntent) {
                            props.transcript?.interaction.anchor(null);
                            return;
                          }
                          if (position.anchor) {
                            props.transcript?.interaction.anchor(
                              {
                                ...position.anchor,
                                messageID: projection()
                                  .repliesByID[position.anchor.key]
                                  ?.messageIDs[0],
                              },
                            );
                          }
                        }}
                        onPins={(keys) =>
                          props.transcript?.pin(
                            keys.flatMap((key) =>
                              projection().repliesByID[key]?.messageIDs ?? []
                            ),
                          )}
                        render={(key) => (
                          <Show when={projection().repliesByID[key]}>
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
                                sessionID: message().sessionID,
                                turnID: turnID(),
                              });
                              return (
                                <Message
                                  sidecarId={props.sidecarId}
                                  ownerID={reply().key}
                                  segments={reply().segments}
                                  message={message()}
                                  lastID={reply().lastID}
                                  pending={reply().pending}
                                  recovery={props.transcript?.state.content
                                    .recovering
                                    ?.find((
                                      p,
                                    ) =>
                                      reply().messageIDs.includes(p.messageID)
                                    )
                                    ?.state ??
                                    (props.transcript?.state.recovering.some((
                                        p,
                                      ) =>
                                        reply().messageIDs.includes(p.messageID)
                                      )
                                      ? "recovering"
                                      : undefined)}
                                  onRetryRecovery={() => void retry()}
                                  usage={props.usageOwner?.priced(
                                    target(),
                                    props.catalog,
                                  )}
                                  summary={sessionSummary(
                                    props.entry,
                                    message(),
                                  )}
                                  digestState={props.entry?.digest.state}
                                  openUsage={props.openUsage
                                    ? () => props.openUsage!(turnID())
                                    : undefined}
                                  usageError={() =>
                                    props.usageError?.(turnID())}
                                  copySource={props.transcript
                                    ? (id, text) =>
                                      props.transcript!.source(id, text)
                                    : undefined}
                                  copyIncomplete={message().role ===
                                      "assistant" &&
                                    !!props.transcript &&
                                    (!props.exhausted &&
                                      (!props.transcript.projection.boundary(
                                        turnID(),
                                      )
                                        ?.firstID ||
                                        !projection()
                                          .messagesByID[reply().firstID]))}
                                  prefs={props.prefs}
                                  directory={props.info?.directory}
                                  permissions={props.permissions}
                                  onOpenChild={props.onOpenChild}
                                  queued={projection().queuedIDs.has(
                                    message().id,
                                  )}
                                  control={(control) => {
                                    const id = message().id;
                                    controls.set(id, control);
                                    return () => {
                                      if (controls.get(id) === control) {
                                        controls
                                          .delete(id);
                                      }
                                    };
                                  }}
                                />
                              );
                            }}
                          </Show>
                        )}
                      />
                    );
                  }}
                </Show>
              </div>
            </div>
            <Show when={!props.child}>
              <ComposerTakeovers
                focusNotice={() => noticeControl?.focus()}
                notice={noticed() ? notice : undefined}
              >
                {(active) => (
                  <div
                    class={["otk-composer-stack", {}]}
                    hidden={active()}
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
            </Show>
          </section>
        </PathProvider>
      </TranscriptContext>
    </HighlightProvider>
  );
}
