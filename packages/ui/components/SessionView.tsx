// SPDX-License-Identifier: LGPL-3.0-only
import { EmptyState } from "./View.tsx";
import "./SessionView.css" with { type: "text" };
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
import Prompt from "./Prompt.tsx";
import ComposerTakeovers from "./ComposerTakeovers.tsx";
import type { Preferences } from "@otk/protocol";
import SubagentBar from "./SubagentBar.tsx";
import RolledBackStrip from "./RolledBackStrip.tsx";
import ForkNote from "./ForkNote.tsx";
import SessionError from "./SessionError.tsx";
import type { SessionErrorState } from "@otk/protocol";
import {
  createTranscriptProjection,
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
  siblings: ContentSession[];
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
  const rollbackNotice = () =>
    !!props.strip || !!props.rollback?.state.pending ||
    !!props.rollback?.state.error;
  const noticed = () => rollbackNotice() || !!props.forkNote;
  const [now, setNow] = createSignal(Date.now());
  const [revealError, setRevealError] = createSignal<string>();
  const older = ownedAction("session.page", () => props.onOlder());
  const retry = ownedAction("session.refetch", () => {
    setRevealError(undefined);
    return props.onRetry();
  });
  const [paneWidth, setPaneWidth] = createSignal(0);
  let view!: HTMLElement;
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
    const observer = new ResizeObserver((entries) =>
      setPaneWidth(entries[0].contentRect.width)
    );
    observer.observe(view);
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
        if (error.name !== "AbortError") {
          setRevealError(
            error instanceof Error
              ? error.message
              : "Previous position is unavailable",
          );
        }
      });
    }
    return () => {
      clearInterval(clock);
      observer.disconnect();
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
        <section
          class="otk-session-view"
          aria-label="Session"
          ref={(element) => {
            view = element;
          }}
        >
          {props.displayMenu}
          <Show when={props.info?.parentID}>
            <SubagentBar
              info={props.info!}
              siblings={props.siblings}
              onOpen={props.onOpenChild}
            />
          </Show>
          <div
            class={["otk-messages", {
              "otk-scrollbar-hidden": !props.prefs.scrollbar,
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
            <Show when={props.loading || props.continuity === "missing"}>
              <p role="status">
                {count() || props.continuity === "missing"
                  ? "Refreshing messages…"
                  : "Loading messages…"}
              </p>
            </Show>
            <div
              class="otk-message-flow"
              data-message-count={count()}
              ref={(element) => {
                flow = element;
              }}
            >
              <Show when={props.paging}>
                <p role="status">Loading earlier messages…</p>
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
              <Show when={props.error}>
                <p role="alert" class="otk-error">{props.error}</p>
                <button type="button" onClick={() => void retry()}>
                  Retry messages
                </button>
              </Show>
              <Show when={revealError()}>
                <p role="alert" class="otk-error">{revealError()}</p>
              </Show>
              <SessionError
                state={props.errorState}
                error={props.sessionError}
              />
              <Show when={props.retryState}>
                {(retry) => (
                  <div class="otk-retry-banner" role="status">
                    <strong>Retrying · attempt {retry().attempt}</strong>
                    <p>{retry().message}</p>
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
                  const positionAnchor = props.transcript?.interaction.anchor();
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
                      measurements={props.transcript?.interaction.measurements}
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
                                  ) => reply().messageIDs.includes(p.messageID))
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
                                summary={sessionSummary(props.entry, message())}
                                digestState={props.entry?.digest.state}
                                openUsage={props.openUsage
                                  ? () => props.openUsage!(turnID())
                                  : undefined}
                                usageError={() => props.usageError?.(turnID())}
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
                                paneWidth={paneWidth()}
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
              <Show
                when={!props.loading && !count() && !props.error &&
                  !props.sessionError && props.continuity !== "missing"}
              >
                <EmptyState>Start a conversation below.</EmptyState>
              </Show>
            </div>
          </div>
          <Show when={!props.child}>
            <ComposerTakeovers>
              {(active) => (
                <div
                  class={["otk-composer-stack", {
                    "is-noticed": noticed(),
                  }]}
                  hidden={active()}
                  inert={active()}
                >
                  <Show when={rollbackNotice()}>
                    <RolledBackStrip
                      strip={props.strip}
                      state={props.rollback?.state ?? {}}
                    />
                  </Show>
                  <Show when={!rollbackNotice() && props.forkNote}>
                    {(note) => (
                      <ForkNote
                        note={note()}
                        onDismiss={() => props.onDismissForkNote?.()}
                      />
                    )}
                  </Show>
                  <div
                    class={["otk-composer-input", {
                      "is-noticed": noticed(),
                    }]}
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
      </TranscriptContext>
    </HighlightProvider>
  );
}
