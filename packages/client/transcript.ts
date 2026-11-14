// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClockedContent,
  compareTranscriptVersion,
  type ContentClock,
  type IntentIdentity,
  type LatestPrompt,
  type LoadCoverage,
  MESSAGE_PAGE_SIZE,
  type MessageCursor,
  type MessagePage,
  type MessagePolicy,
  type TranscriptVersion,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { createProgress, type ProgressDisplay } from "./progress.ts";
import {
  type FailureValue,
  failureValue,
  feedbackError,
} from "./failure-features.ts";
import type { ContentOp, ContentSession, Message, Part } from "@otk/protocol";
import { isAttentionOp } from "@otk/protocol";
import {
  compareMessages,
  isRealPrompt,
  mergePromptSelection,
} from "@otk/protocol";
import { belongsToSession } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
import {
  contentMetadata,
  type ContentState,
  emptyContent,
  reduce,
  reduceRecovery,
} from "./reduce.ts";
import type { Selection } from "./session.ts";
import type {
  BodyTarget,
  Temperature,
  TranscriptRange,
} from "./transcripts.ts";
import { MESSAGE_ADMISSION_WATERMARK } from "./message-policy.ts";
import {
  createTranscriptInteraction,
  type TranscriptInteraction,
} from "./transcript-interaction.ts";
import {
  createTranscriptProjection,
  type TranscriptProjection,
  type TranscriptReply,
} from "./transcript-projection.ts";

function promptAfter(
  previous: LatestPrompt | undefined,
  message: Message,
  read: (id: string) => Message | undefined,
): LatestPrompt | undefined {
  if (!isRealPrompt(message)) {
    return previous?.id === message.id ? undefined : previous;
  }
  const known = previous && read(previous.id);
  if (
    known && known.id !== message.id &&
    compareMessages(known, message) > 0
  ) return previous;
  return {
    id: message.id,
    agent: message.agent,
    model: message.model,
    variant: message.variant,
  };
}

export interface TranscriptState {
  temperature: Temperature;
  revision: number;
  messageIDs: string[];
  messagesByID: Record<string, Message>;
  replyIDs: string[];
  repliesByID: Record<string, TranscriptReply>;
  queuedIDs: Set<string>;
  olderCursor: MessageCursor | null;
  pageLoading: boolean;
  load?: LoadCoverage;
  pageError?: FailureValue;
  session?: ContentSession;
  recovering: { messageID: string; partID: string; generation: number }[];
  view?: "content" | "deleted";
  catalogReady?: boolean;
  deleted?: IndexEntry;
  selection?: Selection;
  info?: ContentSession;
  clock?: ContentClock;
  version?: TranscriptVersion;
  latestPrompt?: LatestPrompt;
  siblings: import("@otk/protocol").SessionStructure[];
  content: ContentState;
  loading: boolean;
  paging: boolean;
  exhausted: boolean;
  /** Missing baselines retain live operations until a successful recovery. */
  continuity: "loading" | "ready" | "missing";
  error?: FailureValue;
}
export type ToolPart = Extract<Part, { kind: "tool" }>;
export type ToolCompletionSource = (
  listener: (part: ToolPart) => void,
) => () => void;
export interface TranscriptOwner {
  progress?(): ProgressDisplay;
  state: TranscriptState;
  readonly projection: TranscriptProjection;
  readonly interaction: TranscriptInteraction;
  source(
    messageID: string,
    text: (part: Part) => string | undefined,
  ): Promise<string>;
  /** Exact native source behind a plugin-owned reference, read on demand. */
  /** One read per reference, success or failure, until Retry replaces it. */
  nativeSource?(
    ref: string,
    options?: { retry?: boolean },
  ): Promise<import("@otk/protocol").NativeSourceView>;
  subscribe(listener: (state: TranscriptState) => void): () => void;
  /** Live completions in this open lifetime; snapshots/paging are silent. */
  onToolCompleted(
    selection: Selection,
    listener: (part: ToolPart) => void,
  ): () => void;
  temperature(value: Temperature): void;
  selected(value: boolean): void;
  viewport(value: TranscriptRange | undefined): void;
  ensure(messageID: string, signal?: AbortSignal): Promise<void>;
  /** Join current newest-page/live-tail authority, never walk older cursors. */
  latest(signal?: AbortSignal): Promise<void>;
  pin(keys: readonly string[]): () => void;
  refetch(): Promise<void>;
  sibling(delta: number): Promise<string | undefined>;
  receive(sidecarId: string, frame: ServerFrame): void;
  older(): Promise<void>;
  latestPrompt(): LatestPrompt | undefined;
  usesMetadata(ids: ReadonlySet<string>): boolean;
  stop(): void;
}
/** Opened Source folds in one transcript lifetime, each a bounded preview. */
const SOURCE_RESULTS = 64;
export function createTranscript(
  target: BodyTarget,
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
  acquire: <T>(read: () => Promise<T>, signal: AbortSignal) => Promise<T>,
  factory: StateFactory = createState,
  policy: () => MessagePolicy | undefined = () =>
    connection(target.sidecarId).messages,
): TranscriptOwner {
  const projection = createTranscriptProjection();
  const readProgress = createProgress(factory);
  let readFacts: import("@otk/protocol").ProgressFacts | undefined;
  let readLabel = "Loading messages";
  let boundaryRead: {
    intent: IntentIdentity;
    epoch: number;
    before?: string;
    revision: number;
    generation?: string;
    streamed?: boolean;
    painted?: boolean;
    prompt?: string;
    complete?: MessagePage & { load: LoadCoverage };
    deliver?(page: MessagePage & { load: LoadCoverage }): void;
  } | undefined;
  const coverage = (load: LoadCoverage): boolean => {
    const pending = boundaryRead;
    if (
      !pending || load.id !== pending.intent.key ||
      load.scope.kind !== "session-messages" ||
      load.scope.sessionID !== target.sessionID ||
      load.boundary.kind !== "page" ||
      load.boundary.before !== pending.before ||
      load.boundary.limit !== MESSAGE_PAGE_SIZE ||
      load.revision <= pending.revision ||
      pending.generation && load.generation !== pending.generation
    ) return false;
    pending.revision = load.revision;
    if (load.generation !== "pending") pending.generation = load.generation;
    setState((draft) => {
      draft.load = load;
    });
    return true;
  };
  const readStage = (
    phase: "queued" | "reading" | "ready",
    generation: string,
    messages = 0,
  ) => {
    const now = Date.now();
    readFacts = {
      generation,
      phase,
      eligible: null,
      completed: 0,
      queued: phase === "queued" ? 1 : 0,
      chunks: phase === "ready" ? 1 : 0,
      messages,
      activeMs: 0,
      started: readFacts?.generation === generation ? readFacts.started : now,
      advanced: now,
      wait: phase === "reading"
        ? (readLabel === "Loading messages"
          ? "waiting for the newest page"
          : "waiting for an earlier page")
        : undefined,
    };
    readProgress.receive("page", readFacts);
  };
  const finishCoverage = () => {
    const pending = boundaryRead, page = pending?.complete;
    if (!pending?.painted || !page) return;
    pending.complete = undefined;
    if (
      !state.version ||
      compareTranscriptVersion(page.version, state.version) !== 0
    ) return;
    if (!coverage(page.load)) return;
    setState((draft) => {
      // Completion advances scalar coverage only. Bodies and accepted live clocks
      // already belong to the atomic page/live reducer.
      projection.boundaries(
        Object.values(page.turns).map((turn) => turn.boundary),
      );
      if (!draft.latestPrompt || draft.latestPrompt.id === pending.prompt) {
        draft.latestPrompt = page.prompt ?? draft.latestPrompt;
      }
      draft.info = page.session;
    });
    if (readFacts) readStage("ready", readFacts.generation, page.items.length);
    queueMicrotask(reserve);
  };
  const readBoundary = (before: string | undefined, signal: AbortSignal) => {
    const sidecar = connection(target.sidecarId), rpc = sidecar.rpc;
    const intent = rpc.intent();
    const early = Promise.withResolvers<MessagePage & { load: LoadCoverage }>();
    const pending: NonNullable<typeof boundaryRead> = {
      intent,
      epoch: sidecar.viewEpoch,
      before,
      revision: -1,
      prompt: state.latestPrompt?.id,
      deliver: early.resolve,
    };
    boundaryRead = pending;
    void rpc.call("session.messages", { sessionID: target.sessionID, before }, {
      intent,
      signal,
    }).then((page) => {
      if (signal.aborted || boundaryRead !== pending) {
        early.reject(
          signal.reason ??
            new DOMException("Message boundary was replaced", "AbortError"),
        );
        return;
      }
      if (!pending.streamed) early.resolve(page);
      else {
        pending.complete = page;
        finishCoverage();
      }
    }).catch((error) => {
      if (!pending.streamed) early.reject(error);
      else if (!signal.aborted && boundaryRead === pending) {
        setState((draft) => {
          draft.pageError = failureValue(error);
        });
      }
    });
    return early.promise;
  };
  const interaction = createTranscriptInteraction();
  const helper = (
    id: string,
  ): import("@otk/protocol").HelperSummary | undefined => {
    const known = entry(target.sidecarId, id);
    return known?.deleted
      ? {
        state: "unavailable",
        revision: known.digest.revision,
        progress: { state: "unavailable" },
      }
      : known?.digest.helper;
  };
  const attach = (content: Omit<ContentState, "messages">): ContentState => {
    Object.defineProperty(content, "messages", {
      configurable: true,
      enumerable: true,
      get: projection.messages,
    });
    return content as ContentState;
  };
  const firstRetained = () =>
    projection.state.messagesByID[projection.state.messageIDs[0]];
  // Source clocks may trail a page read. Updates can change the acquired range,
  // but only the cursor admits older history, including page-captured events.
  const outsideAcquiredRange = (
    op: ContentOp,
    first: Message | undefined,
    bounded: boolean,
  ) =>
    op.op === "message.upsert" && bounded && first &&
    !projection.state.messagesByID[op.message.id] &&
    op.message.time.created < first.time.created;
  const apply = (content: ContentState, op: ContentOp): ContentState => {
    if (
      op.op === "message.upsert" && hasBaseline &&
      outsideAcquiredRange(op, firstRetained(), cursor !== null || tailDirty)
    ) return content;
    if (op.op === "part.remove") interaction.retireIdentity(op.partID);
    if (op.op === "message.remove") {
      interaction.retireIdentity(op.messageID);
      for (
        const part of projection.state.messagesByID[op.messageID]?.parts ?? []
      ) interaction.retireIdentity(part.id);
    }
    const previous = op.op === "part.upsert"
      ? projection.state.messagesByID[op.messageID]
      : undefined;
    return projection.apply(op)
      ? attach(
        reduceRecovery(
          contentMetadata(content),
          op,
          op.op === "part.upsert" &&
            previous !== projection.state.messagesByID[op.messageID],
        ),
      )
      : attach(reduce({ ...contentMetadata(content), messages: [] }, op));
  };
  // Authority is owner-current, even with a deferred framework StateFactory.
  const currentStore = createState<TranscriptState>({
    temperature: "cold",
    revision: 0,
    messageIDs: [],
    messagesByID: {},
    replyIDs: [],
    repliesByID: {},
    queuedIDs: new Set(),
    olderCursor: null,
    pageLoading: false,
    recovering: [],
    content: emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: false,
    continuity: "ready",
    view: "content",
  });
  const binding = factory({ revision: 0 });
  const state = currentStore.state;
  const subscribe = (listener: (value: TranscriptState) => void) =>
    binding.subscribe(() => listener(state));
  const setState = (change: (draft: TranscriptState) => void) => {
    currentStore.update(change);
    const descriptor = Object.getOwnPropertyDescriptor(
      state.content,
      "messages",
    );
    if (descriptor && "value" in descriptor) {
      projection.replace(descriptor.value);
      attach(state.content);
    } else if (!descriptor) attach(state.content);
    state.messageIDs = projection.state.messageIDs;
    state.messagesByID = projection.state.messagesByID;
    state.replyIDs = projection.state.replyIDs;
    state.repliesByID = projection.state.repliesByID;
    state.queuedIDs = projection.state.queuedIDs;
    state.recovering = state.content.recovering ?? [];
    state.olderCursor = cursor;
    state.pageLoading = state.paging || state.loading;
    state.session = state.info;
    state.revision++;
    binding.update((draft) => {
      draft.revision = state.revision;
    });
  };
  let selected: Selection | undefined, generation = 0, load = 0;
  let view: "content" | "deleted" = "content";
  let subscribed = false;
  let buffer: ClockedContent[] = [], bufferBytes = 0, fetching = false;
  let clock: ContentClock | undefined, cursor: MessageCursor | null = null;
  let missing = false, retry: ReturnType<typeof setTimeout> | undefined;
  let hasBaseline = false;
  let initialResync = false;
  let authority: TranscriptVersion | undefined,
    minimum: TranscriptVersion | undefined;
  let nativeConnected = true;
  let retriedVersion: TranscriptVersion | undefined;
  let attentionReads: {
    events: Map<string, ContentOp>;
    bytes: number;
    count: number;
    pending: Set<"permission" | "question">;
  } | undefined;
  let controller: AbortController | undefined;
  let attentionController: AbortController | undefined;
  let range: TranscriptRange | undefined;
  const visited = new Set<string>(), pins = new Map<string, number>();
  const pages = new Map<string | undefined, {
    requestCursor?: string;
    ids: string[];
    older: string | null;
    clock: ContentClock;
  }>();
  let inFlight: Promise<void> | undefined;
  let automatic = false;
  let tailDirty = false;
  let toolGeneration = 0;
  let selectedForTools = false;
  // IDs only: the selected transcript remains the sole owner of part data.
  const completed = new Set<string>(), liveCompleted = new Set<string>();
  const toolListeners = new Set<{
    generation: number;
    delivered: Set<string>;
    listener: (part: ToolPart) => void;
  }>();
  const deliverTool = (part: ToolPart) => {
    for (const observer of toolListeners) {
      if (
        !selectedForTools ||
        observer.generation !== toolGeneration ||
        observer.delivered.has(part.id)
      ) continue;
      observer.delivered.add(part.id);
      observer.listener(part);
    }
  };
  const notePart = (part: Part, live: boolean) => {
    if (
      part.kind !== "tool" || part.call.status !== "completed" ||
      completed.has(part.id)
    ) return;
    completed.add(part.id);
    if (live && selectedForTools) {
      liveCompleted.add(part.id);
      deliverTool(part);
    }
  };
  const baseline = (messages: Message[]) => {
    for (const message of messages) {
      for (const part of message.parts) notePart(part, false);
    }
  };
  const current = (id: number, request: number) =>
    id === generation && request === load;
  const schedule = () => {
    if (retry !== undefined || !selected) return;
    const settings = policy();
    if (!settings) return;
    const id = generation;
    retry = setTimeout(() => {
      retry = undefined;
      if (selected && id === generation) void refetch();
    }, settings.retryms);
  };
  const invalidate = () => {
    missing = true;
    buffer = [];
    bufferBytes = 0;
    load++;
    controller?.abort();
    boundaryRead = undefined;
    fetching = false;
    attentionReads = undefined;
    setState((draft) => {
      draft.loading = false;
      draft.paging = false;
      draft.continuity = "missing";
    });
    schedule();
  };
  const accept = (frame: ClockedContent): boolean => {
    if (!clock || frame.clock.epoch !== clock.epoch) return false;
    if (frame.clock.seq <= clock.seq) return true;
    if (frame.clock.seq !== clock.seq + 1) return false;
    clock = frame.clock;
    return true;
  };
  let siblingCursor: string | null = null;
  const refreshAttention = (siblings = true) => {
    if (!selected || state.temperature !== "screen") return;
    attentionController?.abort();
    const abort = attentionController = new AbortController();
    const target = selected,
      id = generation,
      sidecar = connection(target.sidecarId);
    const valid = () =>
      id === generation && !abort.signal.aborted &&
      state.temperature === "screen";
    const attention = attentionReads = {
      events: new Map<string, ContentOp>(),
      bytes: 0,
      count: 0,
      pending: new Set<"permission" | "question">(["permission", "question"]),
    };
    const optional = async (kind: "permission" | "question") => {
      try {
        if (kind === "permission") {
          const permissions = sidecar.supports("permissions")
            ? await sidecar.rpc.call("permission.list", {
              sessionID: target.sessionID,
            }, abort.signal)
            : [];
          if (!valid()) return;
          setState((draft) => {
            let content = attach({
              ...contentMetadata(draft.content),
              permissions,
            });
            for (const op of attention.events.values()) {
              if (
                op.op === "permission.upsert" || op.op === "permission.remove"
              ) content = apply(content, op);
            }
            draft.content = content;
          });
        } else {
          const questions = sidecar.supports("questions")
            ? await sidecar.rpc.call("question.list", {
              sessionID: target.sessionID,
            }, abort.signal)
            : [];
          if (!valid()) return;
          setState((draft) => {
            let content = attach({
              ...contentMetadata(draft.content),
              questions,
            });
            for (const op of attention.events.values()) {
              if (op.op === "question.upsert" || op.op === "question.remove") {
                content = apply(content, op);
              }
            }
            draft.content = content;
          });
        }
      } catch (error) {
        if (valid()) {
          setState((draft) => {
            draft.error = failureValue(error);
          });
        }
      } finally {
        attention.pending.delete(kind);
        if (!attention.pending.size && attentionReads === attention) {
          attentionReads = undefined;
        }
      }
    };
    void optional("permission");
    void optional("question");
    if (siblings && state.info?.parentID) {
      void sidecar.rpc.call("session.children", {
        sessionID: state.info.parentID,
      }, abort.signal).then((page) => {
        if (valid()) {
          siblingCursor = page.older;
          setState((draft) => {
            draft.siblings = page.items;
          });
        }
      }).catch((error) => {
        if (valid()) {
          setState((draft) => {
            draft.error = failureValue(error);
          });
        }
      });
    }
  };
  const refetch = async () => {
    if (!selected) return;
    if (!policy()) return;
    clearTimeout(retry);
    retry = undefined;
    if (entry(selected.sidecarId, selected.sessionID)?.deleted) {
      return;
    }
    const recovering = missing;
    initialResync = false;
    const target = selected, id = generation, request = ++load;
    const progressGeneration = `${id}:${request}`;
    readLabel = "Loading messages";
    readStage("queued", progressGeneration);
    controller?.abort();
    const abort = controller = new AbortController();
    fetching = true;
    buffer = [];
    bufferBytes = 0;
    missing = false;
    setState((draft) => {
      draft.loading = true;
      draft.paging = false;
      draft.continuity = recovering
        ? "missing"
        : hasBaseline
        ? "ready"
        : "loading";
      draft.error = undefined;
      draft.exhausted = false;
      draft.pageError = undefined;
    });
    try {
      const sidecar = connection(target.sidecarId), rpc = sidecar.rpc;
      const diagnostic = (error: unknown) => {
        if (current(id, request)) {
          setState((draft) => {
            draft.error = failureValue(error);
          });
        }
      };
      refreshAttention(false);
      const page = await acquire(() => {
        readStage("reading", progressGeneration);
        return readBoundary(undefined, abort.signal);
      }, abort.signal);
      const info = page.session, messages = page.items;
      if (boundaryRead) {
        boundaryRead.deliver = undefined;
        boundaryRead.prompt = page.prompt?.id;
      }
      if (!current(id, request)) return;
      if (page.load && !coverage(page.load)) {
        throw new Error("Invalid message coverage");
      }
      if (minimum && compareTranscriptVersion(page.version, minimum) < 0) {
        initialResync = retriedVersion === undefined ||
          compareTranscriptVersion(retriedVersion, minimum) < 0;
        retriedVersion = minimum;
        throw new Error("Message authority was invalidated during baseline");
      }
      if (
        page.sessionID !== target.sessionID ||
        page.from.epoch !== page.clock.epoch || page.from.seq > page.clock.seq
      ) throw new Error("Invalid message baseline");
      let nextClock = page.clock;
      const replay: ClockedContent[] = [];
      for (const frame of buffer) {
        if (frame.clock.epoch !== page.clock.epoch) {
          throw new Error("Message epoch changed during baseline");
        }
        if (frame.clock.seq <= nextClock.seq) continue;
        if (frame.clock.seq !== nextClock.seq + 1) {
          throw new Error("Message baseline has a gap");
        }
        nextClock = frame.clock;
        replay.push(frame);
      }
      clock = nextClock;
      authority = minimum = page.version;
      cursor = page.older;
      tailDirty = false;
      pages.clear();
      pages.set(undefined, {
        ids: messages.map((m) => m.id),
        older: page.older,
        clock: page.clock,
      });
      if (info.parentID && state.temperature === "screen") {
        void rpc.call(
          "session.children",
          { sessionID: info.parentID },
          abort.signal,
        ).then((page) => {
          if (current(id, request)) {
            siblingCursor = page.older;
            setState((draft) => {
              draft.siblings = page.items;
            });
          }
        }).catch(diagnostic);
      } else {setState((draft) => {
          draft.siblings = [];
        });}
      baseline(messages);
      buffer = [];
      bufferBytes = 0;
      fetching = false;
      hasBaseline = true;
      initialResync = false;
      setState((draft) => {
        projection.replace(messages);
        projection.helpers(helper);
        projection.boundaries(
          Object.values(page.turns).map((turn) => turn.boundary),
        );
        let content: ContentState = attach({
          ...contentMetadata(draft.content),
          revert: info.revert || null,
          error: info.error,
          errorState: info.errorState,
          recovering: page.recovering,
          selection: info.selection,
        });
        let latestPrompt = page.prompt;
        for (const { event } of page.catchup) {
          content = apply(content, event);
          if (event.op === "session.selection" && latestPrompt) {
            latestPrompt = mergePromptSelection(latestPrompt, event.selection);
          }
          if (event.op === "message.upsert") {
            latestPrompt = promptAfter(
              latestPrompt,
              event.message,
              (id) => projection.state.messagesByID[id],
            );
          }
        }
        for (const { event } of replay) {
          content = apply(content, event);
          if (event.op === "session.selection" && latestPrompt) {
            latestPrompt = mergePromptSelection(latestPrompt, event.selection);
          }
          if (event.op === "message.upsert") {
            latestPrompt = promptAfter(
              latestPrompt,
              event.message,
              (id) => projection.state.messagesByID[id],
            );
          }
        }
        draft.info = info;
        draft.clock = clock;
        draft.version = authority;
        draft.latestPrompt = latestPrompt;
        draft.content = content;
        draft.loading = false;
        draft.continuity = "ready";
        draft.exhausted = page.older === null;
      });
      queueMicrotask(reserve);
      connection(target.sidecarId).firstPage?.(target.sessionID)();
      if (!page.load || page.load.state === "complete") {
        readStage("ready", progressGeneration, messages.length);
      }
      if (boundaryRead) boundaryRead.painted = true;
      finishCoverage();
    } catch (error) {
      if (!current(id, request)) return;
      buffer = [];
      bufferBytes = 0;
      fetching = false;
      missing = true;
      const resynced = initialResync;
      initialResync = false;
      setState((draft) => {
        draft.loading = false;
        draft.continuity = "missing";
        draft.error = failureValue(error);
        draft.pageError = draft.error;
      });
      if (resynced) {
        retriedVersion = minimum;
        queueMicrotask(() => {
          if (selected && current(id, request) && !fetching) void refetch();
        });
      } else schedule();
    }
  };
  const open = (
    selection?: Selection,
    force = false,
  ) => {
    if (
      selection?.sidecarId === selected?.sidecarId &&
      selection?.sessionID === selected?.sessionID
    ) { if (!force) return; }
    generation++;
    clearTimeout(retry);
    retry = undefined;
    load++;
    boundaryRead = undefined;
    controller?.abort();
    attentionController?.abort();
    if (selected && subscribed) {
      connection(selected.sidecarId).subscribe(selected.sessionID, false);
    }
    subscribed = false;
    selected = selection;
    const deleted = selection &&
      entry(selection.sidecarId, selection.sessionID);
    const nextView = deleted?.deleted ? "deleted" : "content";
    projection.busy(!!deleted && deleted.status !== "idle");
    view = nextView;
    completed.clear();
    liveCompleted.clear();
    buffer = [];
    bufferBytes = 0;
    clock = undefined;
    authority = minimum = undefined;
    retriedVersion = undefined;
    cursor = null;
    missing = false;
    fetching = false;
    hasBaseline = false;
    initialResync = false;
    attentionReads = undefined;
    setState((draft) => {
      draft.selection = selection;
      draft.catalogReady = true;
      draft.view = nextView;
      draft.deleted = deleted?.deleted ? deleted : undefined;
      draft.info = undefined;
      draft.load = undefined;
      draft.clock = undefined;
      draft.version = undefined;
      draft.latestPrompt = undefined;
      draft.siblings = [];
      draft.content = emptyContent();
      draft.loading = !!selection;
      draft.continuity = selection ? "loading" : "ready";
      draft.paging = false;
      draft.exhausted = false;
      draft.error = undefined;
      if (deleted?.deleted) {
        draft.info = {
          id: deleted.id,
          directory: deleted.directory,
          title: deleted.title,
          projectID: deleted.projectID,
          parentID: deleted.parentID,
          archived: deleted.archived,
          time: { created: deleted.timeCreated, updated: deleted.timeUpdated },
        };
        draft.loading = false;
        draft.continuity = "ready";
        draft.exhausted = true;
      }
    });
    if (selection && !deleted?.deleted) {
      connection(selection.sidecarId).subscribe(selection.sessionID, true);
      subscribed = true;
      void refetch();
    }
  };
  const trim = () => {
    if (state.temperature !== "warm") return;
    setState((draft) => {
      const tail = new Set(
        draft.content.messages.slice(-MESSAGE_ADMISSION_WATERMARK).map((m) =>
          m.id
        ),
      );
      const messages = draft.content.messages.filter((m) =>
        tail.has(m.id) || visited.has(m.id) || pins.has(m.id)
      );
      if (messages.length !== draft.content.messages.length) {
        const retained = new Set(messages.map((message) => message.id));
        const removed = new Set(
          draft.content.messages.filter((message) => !retained.has(message.id))
            .map((message) => message.id),
        );
        const covered = new Set(
          [...pages.values()].flatMap((page) => page.ids),
        );
        if (
          [...removed].some((id) => !covered.has(id)) ||
          pages.get(undefined)?.ids.some((id) => removed.has(id))
        ) {
          // Losing live-tail topology requires a new native tail cursor. Merely
          // evicting historical reserve does not invalidate that current tail.
          tailDirty = true;
        } else if (!tailDirty) {
          const seen = new Set<string | undefined>();
          let before: string | undefined;
          while (!seen.has(before)) {
            seen.add(before);
            const page = pages.get(before);
            if (!page) break;
            if (page.ids.some((id) => removed.has(id))) {
              cursor = page.requestCursor!;
              break;
            }
            if (page.older === null) break;
            before = page.older;
          }
        }
        draft.exhausted = false;
      }
      draft.content = {
        ...contentMetadata(draft.content),
        messages,
      };
    });
  };
  const reserve = () => {
    if (
      !selected || state.loading || state.paging || state.exhausted ||
      state.pageError || state.continuity !== "ready" ||
      state.load?.state === "loading"
    ) return;
    const ids = state.content.messages.map((m) => m.id);
    const first = range ? ids.indexOf(range.first) : -1;
    if (
      ids.length < MESSAGE_ADMISSION_WATERMARK ||
      (tailDirty && state.temperature === "screen") ||
      (state.temperature === "screen" && first >= 0 &&
        first <= MESSAGE_ADMISSION_WATERMARK)
    ) {
      automatic = true;
      const work = owner.older();
      automatic = false;
      void work.then(reserve);
    }
  };
  const sources = new Map<
    string,
    Promise<import("@otk/protocol").NativeSourceView>
  >();
  const owner: TranscriptOwner = {
    progress: () => readProgress.display("page", readLabel),
    projection,
    interaction,
    nativeSource: (ref, options) => {
      if (options?.retry) sources.delete(ref);
      let read = sources.get(ref);
      if (read) {
        // Most recently used stays; the oldest bounded entry leaves first.
        sources.delete(ref);
      } else {
        read = connection(target.sidecarId).rpc.call("source.get", {
          sessionID: target.sessionID,
          ref,
        });
        read.catch(() => {});
        if (sources.size >= SOURCE_RESULTS) {
          sources.delete(sources.keys().next().value!);
        }
      }
      sources.set(ref, read);
      return read;
    },
    async source(messageID, text) {
      const id = generation;
      await owner.ensure(messageID);
      const message = state.messagesByID[messageID];
      if (!message) throw new Error("Message is no longer available");
      if (message.role === "assistant") {
        const turnID = message.replyTo ?? message.id, key = `reply:${turnID}`;
        // The authoritative first boundary proves completeness; otherwise walk to the prompt/end.
        while (selected && id === generation) {
          const reply = state.repliesByID[key];
          if (!reply) throw new Error("Reply is no longer available");
          const boundary = projection.boundary(turnID);
          if (boundary?.firstID && state.messagesByID[boundary.firstID]) break;
          if (message.replyTo && state.messagesByID[message.replyTo]) break;
          if (state.exhausted) break;
          await owner.older();
          if (state.pageError) throw feedbackError(state.pageError);
        }
        if (id !== generation || !selected) {
          throw new Error("Reply changed while loading source");
        }
        return state.repliesByID[key].segments.flatMap((segment) =>
          segment.parts.map(text)
        ).filter(Boolean).join("\n\n");
      }
      return message.parts.map(text).filter(Boolean).join("\n\n");
    },
    get state() {
      void binding.state.revision;
      return state;
    },
    subscribe,
    onToolCompleted(selection, listener) {
      const observer = {
        generation: selected?.sidecarId === selection.sidecarId &&
            selected?.sessionID === selection.sessionID
          ? toolGeneration
          : -1,
        delivered: new Set<string>(),
        listener,
      };
      toolListeners.add(observer);
      // Prompt bindings may mount after initial loading. Replay only completion
      // edges received live since open, never already-completed history.
      for (const message of state.content.messages) {
        for (const part of message.parts) {
          if (part.kind === "tool" && liveCompleted.has(part.id)) {
            deliverTool(part);
          }
        }
      }
      return () => {
        toolListeners.delete(observer);
      };
    },
    temperature(value) {
      if (value === state.temperature) return;
      const previous = state.temperature;
      setState((draft) => {
        draft.temperature = value;
      });
      if (value === "cold") {
        readProgress.stop();
        open();
        cursor = null;
        setState((draft) => {
          draft.recovering = [];
        });
        range = undefined;
        tailDirty = false;
        pages.clear();
        visited.clear();
        pins.clear();
        toolListeners.clear();
      } else if (previous === "cold") open(target);
      else {
        if (value === "screen") refreshAttention();
        else {
          attentionController?.abort();
          attentionReads = undefined;
        }
        trim();
        reserve();
      }
    },
    selected(value) {
      if (value && hasBaseline) {
        connection(target.sidecarId).firstPage?.(target.sessionID)();
      }
      if (value === selectedForTools) return;
      selectedForTools = value;
      toolGeneration++;
      liveCompleted.clear();
      baseline(state.content.messages);
    },
    viewport(value) {
      range = value;
      if (value) {
        const ids = state.messageIDs;
        const first = ids.indexOf(value.first), last = ids.indexOf(value.last);
        if (first >= 0 && last >= first) {
          const visible = new Set(ids.slice(first, last + 1));
          for (const page of pages.values()) {
            if (page.ids.some((id) => visible.has(id))) {
              for (const id of page.ids) {
                visited.add(id);
              }
            }
          }
        }
      }
      reserve();
    },
    async ensure(messageID, signal) {
      while (
        selected && !state.content.messages.some((m) => m.id === messageID)
      ) {
        signal?.throwIfAborted();
        if (state.loading) {
          await new Promise<void>((resolve) => {
            const release = subscribe(() => {
              if (!state.loading || !selected) {
                release();
                resolve();
              }
            });
          });
        } else if (state.exhausted) {
          throw new Error("Message is no longer available");
        } else await owner.older();
        if (state.pageError) throw feedbackError(state.pageError);
      }
      if (!selected) {
        throw new DOMException("Transcript demand ended", "AbortError");
      }
      signal?.throwIfAborted();
    },
    latest(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const lifetime = generation;
      return new Promise<void>((resolve, reject) => {
        let release = () => {};
        const finish = (error?: unknown) => {
          release();
          signal?.removeEventListener("abort", abort);
          if (error !== undefined) reject(error);
          else resolve();
        };
        const abort = () => finish(signal!.reason);
        const inspect = () => {
          if (
            !selected || generation !== lifetime || state.temperature === "cold"
          ) {
            finish(new DOMException("Transcript demand ended", "AbortError"));
          } else if (
            connection(target.sidecarId).connected && nativeConnected &&
            hasBaseline && !fetching && !missing && clock && authority &&
            state.continuity === "ready"
          ) {
            finish();
          } else if (!fetching && state.error) {
            finish(feedbackError(state.error));
          }
        };
        release = subscribe(inspect);
        signal?.addEventListener("abort", abort, { once: true });
        // A ready live stream already owns its newest end. Warm-tail trimming
        // may need a fresh *older continuation*, not another newest body read.
        // Missing authority uses the same generation-fenced recovery owner as
        // initial selection and reconnect. Cancelling a waiter never cancels it.
        if (selected && missing && !fetching) void refetch();
        inspect();
      });
    },
    pin(keys) {
      for (const key of keys) pins.set(key, (pins.get(key) ?? 0) + 1);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        for (const key of keys) {
          const count = (pins.get(key) ?? 1) - 1;
          if (count) pins.set(key, count);
          else pins.delete(key);
        }
        trim();
      };
    },
    refetch,
    latestPrompt: () => state.latestPrompt,
    usesMetadata: (ids) =>
      ids.has(target.sessionID) || projection.usesMetadata(ids),
    receive(sidecarId: string, frame: ServerFrame): void {
      if (sidecarId === target.sidecarId && frame.t === "harness") {
        const linked = frame.state === "connected";
        if (nativeConnected !== linked) {
          nativeConnected = linked;
          // Readiness changes even when last-good bodies and their clocks stay.
          setState(() => {});
        }
      }
      if (
        sidecarId === target.sidecarId && frame.t === "harness" && readFacts &&
        readFacts.phase !== "ready"
      ) {
        readFacts = {
          ...readFacts,
          wait: frame.state === "connected"
            ? "waiting for the newest page"
            : "native unavailable",
        };
        readProgress.receive("page", readFacts);
      }
      if (!selected || selected.sidecarId !== sidecarId) return;
      if (frame.t === "load.chunk") {
        const pending = boundaryRead;
        if (
          !pending || frame.epoch !== pending.epoch ||
          frame.request.key !== pending.intent.key ||
          frame.request.clientID !== pending.intent.clientID ||
          frame.request.window !== pending.intent.window ||
          frame.data.kind !== "message-page"
        ) return;
        if (frame.data.page && !pending.streamed) {
          if (
            frame.load.id !== pending.intent.key ||
            frame.load.scope.kind !== "session-messages" ||
            frame.load.scope.sessionID !== target.sessionID ||
            frame.load.boundary.kind !== "page" ||
            frame.load.boundary.before !== pending.before ||
            frame.load.boundary.limit !== MESSAGE_PAGE_SIZE ||
            frame.load.revision <= pending.revision
          ) return;
          pending.streamed = true;
          pending.deliver?.({ ...frame.data.page, load: frame.load });
          return;
        }
        if (!coverage(frame.load)) return;
        // Body pages are atomic. Progress cannot install partial source or retire
        // a content clock; only the coordinated page result can do that.
        if (frame.load.state === "complete" && readFacts) {
          readStage("ready", readFacts.generation, state.messageIDs.length);
        }
        return;
      }
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        const known = entry(sidecarId, selected.sessionID);
        const busyChanged = projection.busy(
          known?.status !== undefined && known.status !== "idle",
        );
        if (projection.helpers(helper) || busyChanged) {
          setState((draft) => {
            draft.content = attach(contentMetadata(draft.content));
          });
        }
        if (known?.deleted) interaction.clear();
        if (
          !!known?.deleted !== (view === "deleted") ||
          (!subscribed && view !== "deleted")
        ) open(selected, true);
        else if (known?.deleted) {
          setState((draft) => {
            draft.deleted = known;
          });
        }
        return;
      }
      if (view === "deleted") return;
      if (frame.t === "bootstrap.complete") {
        refreshAttention(false);
        return;
      }
      if (frame.t === "transcript.invalidated") {
        if (
          frame.sessionID !== undefined &&
          frame.sessionID !== selected.sessionID
        ) return;
        if (minimum && compareTranscriptVersion(frame.version, minimum) <= 0) {
          return;
        }
        minimum = frame.version;
        if (authority && compareTranscriptVersion(authority, minimum) >= 0) {
          return;
        }
        if (fetching && !hasBaseline) {
          initialResync = true;
          return;
        }
        clock = undefined;
        missing = true;
        void refetch();
        return;
      }
      if (frame.t === "welcome") {
        authority = minimum = undefined;
        void refetch();
        return;
      }
      if (frame.t !== "content") return;
      if (isAttentionOp(frame.event)) {
        if (
          !belongsToSession(
            frame.sessionID,
            selected.sessionID,
            (id) => entry(sidecarId, id),
          )
        ) {
          // Scoped index credit can deliver the request before its asking
          // session's ancestry. Reacquire from the pending owner, rather than
          // discard the only event or guess that the request is unrelated.
          if (!entry(sidecarId, frame.sessionID)) refreshAttention(false);
          return;
        }
      } else if (frame.sessionID !== selected.sessionID) return;
      if (frame.event.op === "part.upsert") notePart(frame.event.part, true);
      if (frame.event.op === "message.upsert") baseline([frame.event.message]);
      if (isAttentionOp(frame.event) && attentionReads) {
        const event = frame.event;
        const key = event.op === "permission.upsert"
          ? `permission:${event.request.id}`
          : event.op === "permission.remove"
          ? `permission:${event.requestID}`
          : event.op === "question.upsert"
          ? `question:${event.request.id}`
          : event.op === "question.remove"
          ? `question:${event.requestID}`
          : undefined;
        if (
          key &&
          attentionReads.pending.has(
            key.startsWith("permission:") ? "permission" : "question",
          )
        ) {
          const settings = policy()!;
          const bytes =
            new TextEncoder().encode(JSON.stringify(event)).byteLength;
          if (
            ++attentionReads.count > settings.replayops ||
            attentionReads.bytes + bytes > settings.replaybytes
          ) invalidate();
          else {
            attentionReads.bytes += bytes;
            attentionReads.events.set(key, event);
          }
        }
      }
      if (isAttentionOp(frame.event)) {
        setState((draft) => {
          draft.content = apply(draft.content, frame.event);
        });
        return;
      }
      if (frame.event.op === "stream.reconcile") {
        invalidate();
        return;
      }
      if (missing) return;
      if (!frame.clock) {
        invalidate();
        return;
      }
      if (fetching) {
        const settings = policy()!;
        const value = { clock: frame.clock, event: frame.event };
        const bytes =
          new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (
          buffer.length >= settings.replayops ||
          bufferBytes + bytes > settings.replaybytes
        ) {
          invalidate();
          return;
        }
        buffer.push(value);
        bufferBytes += bytes;
      } else {
        const duplicate = clock?.epoch === frame.clock.epoch &&
          frame.clock.seq <= clock.seq;
        if (!accept({ clock: frame.clock, event: frame.event })) {
          invalidate();
          return;
        }
        if (duplicate) return;
        if (
          state.temperature === "warm" && frame.event.op === "message.upsert" &&
          !state.messagesByID[frame.event.message.id] &&
          ([...pages.values()].some((page) =>
            page.ids.includes(
              frame.event.op === "message.upsert" ? frame.event.message.id : "",
            )
          ) ||
            frame.event.message.time.created <
              (state.content.messages.at(-MESSAGE_ADMISSION_WATERMARK)?.time
                .created ?? -Infinity))
        ) {
          // Only retained pages and the live tail own bodies; old identities do not resurrect their source.
          setState((draft) => {
            draft.clock = clock;
          });
          return;
        }
        try {
          setState((draft) => {
            draft.content = apply(draft.content, frame.event);
            draft.clock = clock;
            if (frame.event.op === "session.selection") {
              if (draft.latestPrompt) {
                draft.latestPrompt = mergePromptSelection(
                  draft.latestPrompt,
                  frame.event.selection,
                );
              }
              if (draft.info) {
                draft.info = {
                  ...draft.info,
                  selection: mergePromptSelection(
                    draft.info.selection ?? {},
                    frame.event.selection,
                  ),
                };
              }
            }
            if (
              frame.event.op === "message.upsert"
            ) {
              draft.latestPrompt = promptAfter(
                draft.latestPrompt,
                frame.event.message,
                (id) => state.messagesByID[id],
              );
            }
          });
          if (
            frame.event.op === "message.upsert" ||
            frame.event.op === "message.remove"
          ) trim();
        } catch {
          invalidate();
        }
      }
    },
    async sibling(delta) {
      if (!selected || !state.info?.parentID) return;
      const target = selected, id = generation, request = load;
      const find = () =>
        state.siblings.findIndex((item) => item.id === target.sessionID);
      while (
        siblingCursor &&
        (find() < 0 || delta > 0 && find() === state.siblings.length - 1 ||
          delta < 0 && find() === 0)
      ) {
        const before = siblingCursor;
        const page = await connection(target.sidecarId).rpc.call(
          "session.children",
          {
            sessionID: state.info.parentID,
            before,
          },
          controller?.signal,
        );
        if (!current(id, request)) return;
        if (page.older === before) {
          throw new Error("Sibling cursor did not advance");
        }
        siblingCursor = page.older;
        setState((draft) => {
          const values = new Map(draft.siblings.map((item) => [item.id, item]));
          for (const item of page.items) values.set(item.id, item);
          draft.siblings = [...values.values()];
        });
      }
      const at = find(), size = state.siblings.length;
      return at < 0 || !size
        ? undefined
        : state.siblings[(at + delta + size) % size]?.id;
    },
    older(): Promise<void> {
      if (inFlight) return inFlight;
      if (
        !selected || state.loading || state.paging ||
        (!tailDirty && (state.exhausted || cursor === null))
      ) return Promise.resolve();
      const target = selected,
        id = generation,
        request = load;
      let before: string | undefined = tailDirty
        ? undefined
        : cursor ?? undefined;
      const retain = !automatic;
      if (retain) {
        for (const message of state.content.messages) visited.add(message.id);
      }
      setState((draft) => {
        draft.paging = true;
        draft.error = undefined;
        draft.pageError = undefined;
      });
      const read = async () => {
        try {
          for (;;) {
            const progressGeneration = `${id}:${request}:older:${
              before ?? "tail"
            }`;
            readLabel = "Loading earlier messages";
            readStage("queued", progressGeneration);
            const page = await acquire(
              () => {
                readStage("reading", progressGeneration);
                return readBoundary(before, controller!.signal);
              },
              controller!.signal,
            );
            if (!current(id, request)) return;
            if (boundaryRead) boundaryRead.deliver = undefined;
            if (page.load && !coverage(page.load)) {
              throw new Error("Invalid message coverage");
            }
            if (
              page.sessionID !== target.sessionID ||
              page.clock.epoch !== clock?.epoch
            ) {
              invalidate();
              return;
            }
            let loaded = { ...emptyContent(), messages: page.items };
            const retained = firstRetained(), pageFirst = page.items[0];
            const first = retained &&
                (!pageFirst || retained.time.created < pageFirst.time.created)
              ? retained
              : pageFirst;
            for (const { event } of page.catchup) {
              if (outsideAcquiredRange(event, first, page.older !== null)) {
                continue;
              }
              loaded = reduce(loaded, event);
            }
            const messages = loaded.messages;
            if (page.older !== null && page.older === before) {
              throw new Error("Message cursor did not advance");
            }
            if (retain) {
              for (const message of messages) visited.add(message.id);
            }
            cursor = page.older;
            tailDirty = false;
            pages.set(before, {
              requestCursor: before,
              ids: messages.map((m) => m.id),
              older: page.older,
              clock: page.clock,
            });
            baseline(messages);
            const added = messages.filter((m) => !state.messagesByID[m.id]);
            setState((draft) => {
              projection.merge(added);
              projection.helpers(helper);
              projection.boundaries(
                Object.values(page.turns).map((turn) => turn.boundary),
              );
              let metadata = contentMetadata(draft.content);
              for (const recovering of page.recovering) {
                if (
                  added.some((message) => message.id === recovering.messageID)
                ) {
                  metadata = reduceRecovery(metadata, {
                    op: "stream.recovery",
                    ...recovering,
                    state: "recovering",
                  });
                }
              }
              draft.content = attach(metadata);
              draft.exhausted = page.older === null;
              draft.paging = !added.length && page.older !== null;
            });
            if (!page.load || page.load.state === "complete") {
              readStage("ready", progressGeneration, page.items.length);
            }
            if (boundaryRead) boundaryRead.painted = true;
            finishCoverage();
            if (added.length || page.older === null) return;
            before = page.older;
          }
        } catch (error) {
          if (current(id, request)) {
            setState((draft) => {
              draft.paging = false;
              draft.error = failureValue(error);
              draft.pageError = draft.error;
            });
          }
        }
      };
      const work = read().finally(() => {
        if (inFlight === work) inFlight = undefined;
      });
      inFlight = work;
      return work;
    },
    stop(): void {
      readProgress.stop();
      interaction.clear();
      sources.clear();
      owner.temperature("cold");
    },
  };
  return owner;
}
