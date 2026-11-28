// SPDX-License-Identifier: LGPL-3.0-only
import { entityKey, randomID } from "@otk/protocol";
import { type EntityStateStore, sessionRunning } from "./entity-state.ts";
import {
  type ClockedContent,
  compareTranscriptVersion,
  type ContentClock,
  ContentDeliveryDiagnostics,
  type LatestPrompt,
  type LoadCoverage,
  MESSAGE_PAGE_SIZE,
  type MessageCursor,
  type MessagePage,
  type MessagePolicy,
  type TranscriptVersion,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { RequestFailure, retireFailureOccurrence } from "./failures.ts";
import { createProgress, type ProgressDisplay } from "./progress.ts";
import {
  type FailureValue,
  failureValue,
  feedbackError,
} from "./failure-features.ts";
import type { ContentOp, ContentSession, Message, Part } from "@otk/protocol";
import { isAttentionOp, isCancellation } from "@otk/protocol";
import {
  createNativeSources,
  type NativeSourceOwner,
} from "./native-sources.ts";
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
import { type CoverageGap, createAcquiredRange } from "./acquired-range.ts";
import {
  createTranscriptInteraction,
  type TranscriptInteraction,
} from "./transcript-interaction.ts";
import type { Disclosures } from "./disclosure.ts";
import { sessionKey } from "./index.ts";
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

export interface TranscriptGapState extends CoverageGap {
  state: "idle" | "loading" | "failed";
  failure?: FailureValue;
}

export interface TranscriptState {
  appendRevision?: number;
  temperature: Temperature;
  revision: number;
  messageIDs: string[];
  messagesByID: Record<string, Message>;
  replyIDs: string[];
  repliesByID: Record<string, TranscriptReply>;
  queuedIDs: Set<string>;
  records: import("./activity-spans.ts").RecordProjection;
  gaps: readonly TranscriptGapState[];
  olderCursor: MessageCursor | null;
  pageLoading: boolean;
  load?: LoadCoverage;
  pageError?: FailureValue;
  session?: ContentSession;
  recovering: MessagePage["recovering"];
  view?: "content" | "deleted";
  catalogReady?: boolean;
  deleted?: IndexEntry;
  selection?: Selection;
  info?: ContentSession;
  clock?: ContentClock;
  version?: TranscriptVersion;
  latestPrompt?: LatestPrompt;
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
  send?(value: import("./pending-send.ts").PendingSend): void;
  cancelSend?(messageID: string, withdrawn?: boolean): void;
  readonly deliveryDiagnostics?: ContentDeliveryDiagnostics;
  progress?(): ProgressDisplay;
  state: TranscriptState;
  readonly projection: TranscriptProjection;
  readonly interaction: TranscriptInteraction;
  /** Detached explicit archive demand, admitted by the canonical body owner.
   * Does not replace the live viewport's paging boundary or projection. */
  snapshotPage(
    before?: string,
    signal?: AbortSignal,
    scope?: import("@otk/protocol").MessageSnapshotScope,
  ): Promise<MessagePage>;
  source(
    messageID: string,
    text: (part: Part) => string | undefined,
  ): Promise<string>;
  /** Exact native source behind a plugin-owned reference, read on demand. */
  /** Borrow one Source resource for this reference's current content lifetime. */
  nativeSource?(
    ref: string,
  ): NativeSourceOwner;
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
  /** Coalesced read-only recovery of missing correlated send identities. */
  reconcile(messageIDs: readonly string[]): Promise<void>;
  pin(keys: readonly string[]): () => void;
  refetch(): Promise<void>;
  receive(sidecarId: string, frame: ServerFrame): void;
  older(): Promise<void>;
  bridge(key?: string): Promise<void>;
  latestPrompt(): LatestPrompt | undefined;
  usesMetadata(ids: ReadonlySet<string>): boolean;
  stop(): void;
}
/** Opened Source folds in one transcript lifetime, each a bounded preview. */
const SOURCE_RESULTS = 64;
const missingMessage = () =>
  new RequestFailure({
    code: "message.missing",
    retry: "none",
    diagnosticID: randomID(),
  });
export function createTranscript(
  target: BodyTarget,
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
  acquire: <T>(read: () => Promise<T>, signal: AbortSignal) => Promise<T>,
  factory: StateFactory = createState,
  policy: () => MessagePolicy | undefined = () =>
    connection(target.sidecarId).messages,
  entities?: EntityStateStore,
  disclosures?: Disclosures,
  retireScope?: (scope: string) => void,
): TranscriptOwner {
  const requests = connection(target.sidecarId).attention;
  const requestEntry = (id: string) => entry(target.sidecarId, id);
  const projection = createTranscriptProjection();
  const acquired = createAcquiredRange();
  const deliveryDiagnostics = new ContentDeliveryDiagnostics("browser");
  const sources = createNativeSources({
    messages: () => projection.state.messagesByID,
    load: (ref, signal) =>
      connection(target.sidecarId).rpc.call("source.get", {
        sessionID: target.sessionID,
        ref,
      }, signal),
    limit: SOURCE_RESULTS,
  });
  const readProgress = createProgress(factory);
  let readFacts: import("@otk/protocol").ProgressFacts | undefined;
  let readLabel = "Loading messages";
  let boundaryRead: {
    intent: import("./requests.ts").ClientIntent;
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
  const readBoundary = (
    before: string | undefined,
    signal: AbortSignal,
    retryRecovery = false,
    reading: () => void = () => {},
  ) => {
    const deadline = AbortSignal.timeout(75_000);
    const requestSignal = AbortSignal.any([signal, deadline]);
    const sidecar = connection(target.sidecarId), rpc = sidecar.rpc;
    const intent = rpc.intent();
    const early = Promise.withResolvers<MessagePage & { load: LoadCoverage }>();
    let pending: NonNullable<typeof boundaryRead> | undefined;
    // Atomic body delivery may paint early, but the admitted native read owns
    // its slot through metadata coverage. Otherwise warm bodies admit an
    // unbounded population of unfinished interactive metadata publications.
    void acquire(() => {
      reading();
      const request: NonNullable<typeof boundaryRead> = pending = {
        intent,
        epoch: sidecar.viewEpoch,
        before,
        revision: -1,
        prompt: state.latestPrompt?.id,
        deliver: early.resolve,
      };
      boundaryRead = request;
      return rpc.call("session.messages", {
        sessionID: target.sessionID,
        before,
        ...(retryRecovery ? { retryRecovery: true } : {}),
      }, { intent, signal: requestSignal }).then((page) => {
        if (requestSignal.aborted || boundaryRead !== request) {
          early.reject(
            requestSignal.reason ??
              new DOMException("Message boundary was replaced", "AbortError"),
          );
          return;
        }
        if (!request.streamed) early.resolve(page);
        else {
          request.complete = page;
          finishCoverage();
        }
      });
    }, requestSignal).catch((error) => {
      const cause = deadline.aborted && !signal.aborted
        ? new Error("History is taking longer than expected. Retry messages.")
        : error;
      if (!pending?.streamed) early.reject(cause);
      else if (!signal.aborted && boundaryRead === pending) {
        if (readFacts) readStage("ready", readFacts.generation);
        setState((draft) => {
          draft.load = undefined;
          draft.pageError = draft.error = failureValue(cause);
        });
      }
    });
    return early.promise;
  };
  const scope = sessionKey(target.sidecarId, target.sessionID);
  const interaction = createTranscriptInteraction(disclosures, scope);
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
    for (const kind of ["permissions", "questions", "forms"] as const) {
      Object.defineProperty(content, kind, {
        configurable: true,
        enumerable: true,
        get: () => requests[kind](target.sessionID, requestEntry),
      });
    }
    Object.defineProperty(content, "messages", {
      configurable: true,
      enumerable: true,
      get: projection.messages,
    });
    return content as ContentState;
  };
  const firstRetained = () =>
    projection.state.messagesByID[
      projection.state.messageIDs.find((id) => projection.committed(id))!
    ];
  // Source clocks may trail a page read. Updates can change the acquired range,
  // but only the cursor admits older history, including page-captured events.
  const outsideAcquiredRange = (
    op: ContentOp,
    first: Message | undefined,
    bounded: boolean,
  ) =>
    op.op === "message.upsert" && bounded && first &&
    !projection.state.messagesByID[op.message.id] &&
    compareMessages(op.message, first) < 0;
  const apply = (content: ContentState, op: ContentOp): ContentState => {
    if (isAttentionOp(op)) {
      requests.receive(op);
      return attach(contentMetadata(content));
    }
    if (
      op.op === "message.upsert" && hasBaseline &&
      outsideAcquiredRange(op, firstRetained(), acquired.next !== null)
    ) return content;
    const retirePartFailure = (part: Part) => {
      retireFailureOccurrence(interaction.disclosures, part);
      if (part.kind === "external" && part.failure) {
        retireFailureOccurrence(interaction.disclosures, part.failure);
      }
      if (part.kind === "tool") {
        retireFailureOccurrence(interaction.disclosures, part.call);
      }
    };
    if (op.op === "part.remove") {
      const part = projection.state.messagesByID[op.messageID]?.parts.find(
        (part) => part.id === op.partID,
      );
      if (part) retirePartFailure(part);
      interaction.retireIdentity(op.partID);
    }
    const removedReply = op.op === "message.remove"
      ? projection.entry(op.messageID)?.key
      : undefined;
    if (op.op === "message.remove") {
      acquired.remove(op.messageID);
      interaction.retireIdentity(op.messageID);
      for (
        const part of projection.state.messagesByID[op.messageID]?.parts ?? []
      ) {
        retirePartFailure(part);
        interaction.retireIdentity(part.id);
      }
    }
    const previous = op.op === "part.upsert"
      ? projection.state.messagesByID[op.messageID]
      : undefined;
    // Native source can change even when its neutral presentation is equal.
    // Structural location, not decoding an opaque ref, identifies this owner.
    if (op.op === "message.upsert") {
      sources.changed(op.message.id, undefined, op.message);
    } else if (
      "messageID" in op && op.messageID !== undefined &&
      ["part.upsert", "part.remove", "part.blocks", "message.clock"].includes(
        op.op,
      )
    ) {
      sources.changed(
        op.messageID,
        op.op === "part.upsert"
          ? op.part.id
          : "partID" in op
          ? op.partID
          : undefined,
        op.op === "part.upsert" ? op.part : undefined,
      );
    }
    const recordBefore = projection.state.records;
    const projected = projection.apply(op);
    if (op.op === "message.upsert" && projection.materialized(op.message.id)) {
      acquired.observe(op.message);
    }
    // A native message may be one step of a reply. Retire the logical key
    // only when the reply itself is deleted, not when one step is removed.
    if (
      op.op === "message.remove" && removedReply !== undefined &&
      removedReply !== op.messageID &&
      !projection.state.repliesByID[removedReply]
    ) interaction.retireIdentity(removedReply);
    if (recordBefore !== projection.state.records) {
      const before = new Set(Object.values(recordBefore.parents).flat());
      const after = new Set(
        Object.values(projection.state.records.parents).flat(),
      );
      for (const key of before) {
        if (!after.has(key)) {
          interaction.retire(key);
          interaction.retireIdentity(key);
        }
      }
    }
    return projected
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
    records: projection.state.records,
    gaps: [],
    olderCursor: null,
    pageLoading: false,
    recovering: [],
    content: emptyContent(),
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
  let updating = false;
  const setState = (change: (draft: TranscriptState) => void) => {
    // Applying a page's attention events can synchronously notify this owner.
    // Only the outer transaction publishes the projection.
    if (updating) return;
    updating = true;
    try {
      currentStore.update(change);
    } finally {
      updating = false;
    }
    state.messageIDs = projection.state.messageIDs;
    state.messagesByID = projection.state.messagesByID;
    state.replyIDs = projection.state.replyIDs;
    state.repliesByID = projection.state.repliesByID;
    state.queuedIDs = projection.state.queuedIDs;
    state.records = projection.state.records;
    state.appendRevision = projection.state.appendRevision;
    sources.sync();
    state.recovering = state.content.recovering ?? [];
    state.olderCursor = acquired.next ?? null;
    state.exhausted = state.view === "deleted" || acquired.next === null;
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
  let clock: ContentClock | undefined;
  // Keep the last accepted clock even when live admission drops its clock.
  let lastClock: ContentClock | undefined;
  let missing = false, retry: ReturnType<typeof setTimeout> | undefined;
  let recoveryAttempted = false;
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
  } | undefined;
  let controller: AbortController | undefined;
  let attentionController: AbortController | undefined;
  let range: TranscriptRange | undefined;
  const visited = new Set<string>(), pins = new Map<string, number>();
  let inFlight: Promise<void> | undefined;
  let repairingHead: Promise<void> | undefined;
  let reconciling: Promise<void> | undefined;
  let automatic = false;
  let bridging: { key: string; failure?: FailureValue } | undefined;
  const publishGaps = (draft: TranscriptState) => {
    const gaps = acquired.gaps();
    if (
      gaps.length !== draft.gaps.length ||
      gaps.some((gap, i) =>
        gap.key !== draft.gaps[i].key || gap.newer !== draft.gaps[i].newer ||
        gap.older !== draft.gaps[i].older
      )
    ) projection.gaps(gaps);
    draft.gaps = gaps.map((gap) => {
      if (gap.key !== bridging?.key) return { ...gap, state: "idle" };
      return bridging.failure
        ? { ...gap, state: "failed", failure: bridging.failure }
        : { ...gap, state: "loading" };
    });
  };
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
    if (retry !== undefined || recoveryAttempted || !selected) return;
    const settings = policy();
    if (!settings) return;
    const id = generation;
    retry = setTimeout(() => {
      retry = undefined;
      if (selected && id === generation) {
        recoveryAttempted = true;
        void reacquireNewest("recovery");
      }
    }, settings.retryms);
  };
  const invalidate = () => {
    sources.invalidate();
    missing = true;
    buffer = [];
    bufferBytes = 0;
    load++;
    controller?.abort();
    boundaryRead = undefined;
    fetching = false;
    inFlight = undefined;
    bridging = undefined;
    attentionReads = undefined;
    setState((draft) => {
      draft.loading = false;
      draft.paging = false;
      draft.continuity = "missing";
      draft.load = undefined;
      publishGaps(draft);
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
  const refreshAttention = () => {
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
    };
    const optional = async (kind: "permission" | "question") => {
      try {
        if (kind === "permission") {
          await sidecar.readPermissions(
            target.sessionID,
            requestEntry,
            abort.signal,
          );
        } else {
          const questions = sidecar.supports("questions")
            ? await sidecar.rpc.call("question.list", {
              sessionID: target.sessionID,
            }, abort.signal)
            : [];
          if (!valid()) return;
          setState((draft) => {
            requests.replace(
              "question",
              questions,
              target.sessionID,
              requestEntry,
              [...attention.events.values()],
            );
            let content = attach(contentMetadata(draft.content));
            for (const op of attention.events.values()) {
              if (op.op === "question.upsert" || op.op === "question.remove") {
                content = apply(content, op);
              }
            }
            draft.content = content;
          });
        }
      } catch (error) {
        if (valid() && !isCancellation(error)) {
          setState((draft) => {
            draft.error = failureValue(error);
          });
        }
      } finally {
        if (kind === "question" && attentionReads === attention) {
          attentionReads = undefined;
        }
      }
    };
    void optional("permission");
    void optional("question");
  };
  type NewestCause =
    | "open"
    | "recovery"
    | "invalidated"
    | "resync"
    | "welcome"
    | "latest"
    | "send"
    | "retry"
    | "head-repair";
  const reconcileNewest = (
    page: MessagePage,
    replay: readonly ClockedContent[],
    cause: NewestCause,
  ) => {
    const { items, session: info } = page;
    const same = authority !== undefined &&
      compareTranscriptVersion(page.version, authority) === 0 &&
      lastClock?.epoch === page.clock.epoch &&
      // Same epoch/version alone does not prove that an unseen interval
      // contains no edits to acquired history.
      page.from.seq <= lastClock.seq;
    const held = projection.messages().filter((message) =>
      projection.committed(message.id)
    );
    const pageIDs = new Set(items.map((message) => message.id));
    const recovering = state.recovering.filter((value) =>
      !pageIDs.has(value.messageID)
    );
    clock = lastClock = replay.at(-1)?.clock ?? page.clock;
    authority = minimum = page.version;
    baseline(items);
    buffer = [];
    bufferBytes = 0;
    fetching = false;
    hasBaseline = true;
    initialResync = false;
    setState((draft) => {
      const { deleted } = acquired.head(page, held, { same });
      projection.reconcile(items, page);
      let content: ContentState = attach({
        ...contentMetadata(draft.content),
        revert: info.revert || null,
        revertCommitted: info.revertCommitted ?? draft.content.revertCommitted,
        error: info.error,
        errorState: info.errorState,
        recovering: [...recovering, ...page.recovering],
        selection: info.selection,
      });
      for (const messageID of deleted) {
        content = apply(content, { op: "message.remove", messageID });
      }
      let latestPrompt = page.prompt;
      for (const { event } of [...page.catchup, ...replay]) {
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
      projection.helpers(helper);
      projection.boundaries(
        Object.values(page.turns).map((turn) => turn.boundary),
      );
      publishGaps(draft);
      draft.info = info;
      draft.clock = clock;
      draft.version = authority;
      draft.latestPrompt = latestPrompt;
      draft.content = content;
      draft.loading = false;
      draft.continuity = "ready";
    });
    // Head repair's caller will run the batch. Otherwise only an on-screen
    // transcript bridges automatically, after newest waiters can settle.
    if (
      cause !== "head-repair" && state.gaps.length &&
      state.temperature === "screen"
    ) {
      const request = load;
      queueMicrotask(() => {
        if (request === load && state.temperature === "screen") {
          void owner.bridge();
        }
      });
    }
  };
  const reacquireNewest = async (cause: NewestCause, retryRecovery = false) => {
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
    inFlight = undefined;
    bridging = undefined;
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
      draft.pageError = undefined;
      publishGaps(draft);
    });
    try {
      refreshAttention();
      const page = await readBoundary(
        undefined,
        abort.signal,
        retryRecovery,
        () => {
          readStage("reading", progressGeneration);
        },
      );
      const messages = page.items;
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
      reconcileNewest(page, replay, cause);
      recoveryAttempted = false;
      queueMicrotask(reserve);
      deliveryDiagnostics.record({
        ...target,
        operation: "page",
        clock,
        state: "accepted",
      });
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
        draft.load = undefined;
        draft.error = failureValue(error);
        draft.pageError = draft.error;
      });
      if (resynced) {
        retriedVersion = minimum;
        queueMicrotask(() => {
          if (selected && current(id, request) && !fetching) {
            void reacquireNewest("resync");
          }
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
    recoveryAttempted = false;
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
    projection.busy(
      !!entities &&
        sessionRunning(entities, entityKey("session", target.sessionID)),
    );
    view = nextView;
    completed.clear();
    liveCompleted.clear();
    buffer = [];
    bufferBytes = 0;
    clock = lastClock = undefined;
    authority = minimum = undefined;
    retriedVersion = undefined;
    acquired.clear();
    // Body acquisition can reset without retiring the tab's interaction scope.
    // Deletion and stop own retirement of disclosure choices and anchors.
    inFlight = repairingHead = undefined;
    bridging = undefined;
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
      // Window lifetime changes do not turn projected local sends into native
      // input. Replace only the native window; pending entries survive it.
      projection.reset([]);
      publishGaps(draft);
      draft.content = attach(emptyContent());
      draft.loading = !!selection;
      draft.continuity = selection ? "loading" : "ready";
      draft.paging = false;
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
      }
    });
    if (selection && !deleted?.deleted) {
      connection(selection.sidecarId).subscribe(selection.sessionID, true);
      subscribed = true;
      void reacquireNewest("open");
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
      const retained = new Set([...tail, ...visited, ...pins.keys()]);
      const ordered = draft.messageIDs.filter(projection.committed);
      const removed = new Set(ordered.filter((id) => !retained.has(id)));
      if (removed.size) projection.park(acquired.evict(ordered, removed));
      projection.retain(retained);
    });
  };
  const reserve = () => {
    if (
      !selected || repairingHead || state.loading || state.paging ||
      state.exhausted ||
      state.pageError || state.gaps.length || state.continuity !== "ready" ||
      state.load?.state === "loading"
    ) return;
    const ids = state.messageIDs;
    const first = range ? ids.indexOf(range.first) : -1;
    if (
      ids.length < MESSAGE_ADMISSION_WATERMARK ||
      (acquired.next === undefined && state.temperature === "screen") ||
      (state.temperature === "screen" && first >= 0 &&
        first <= MESSAGE_ADMISSION_WATERMARK)
    ) {
      automatic = true;
      const work = owner.older();
      automatic = false;
      const length = ids.length;
      void work.then(() => {
        if (state.messageIDs.length > length) reserve();
      });
    }
  };
  const snapshotLifetime = new AbortController();
  const releaseRequests = requests.subscribe(() =>
    setState((draft) => {
      draft.content = attach(contentMetadata(draft.content));
    })
  );
  const owner: TranscriptOwner = {
    deliveryDiagnostics,
    progress: () => {
      const history = state.load?.state === "loading" && !state.loading &&
        !state.paging && state.continuity === "ready";
      const progress = readProgress.display(
        "page",
        history ? "Loading history" : readLabel,
      );
      return history && !progress.stalled
        ? { ...progress, text: "Loading history" }
        : progress;
    },
    projection,
    send(value) {
      projection.send(value);
      setState(() => {});
    },
    cancelSend(messageID, withdrawn) {
      projection.cancelSend(messageID, withdrawn);
      setState(() => {});
    },
    interaction,
    snapshotPage: (before, cancellation, scope) => {
      const signal = cancellation
        ? AbortSignal.any([snapshotLifetime.signal, cancellation])
        : snapshotLifetime.signal;
      return acquire(
        () =>
          connection(target.sidecarId).rpc.call("history.messages", {
            sessionID: target.sessionID,
            before,
            ...(scope ? { scope } : {}),
          }, { signal }),
        signal,
      );
    },
    nativeSource: sources.get,
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
          const first = boundary?.firstID ?? message.replyTo;
          if (
            first && projection.materialized(first) &&
            acquired.current(first) &&
            reply.segments.every((segment) =>
              acquired.current(segment.messageID)
            )
          ) break;
          if (state.exhausted) break;
          await owner.older();
          if (state.pageError) throw feedbackError(state.pageError);
        }
        if (id !== generation || !selected) {
          throw new Error("Reply changed while loading source");
        }
        const reply = state.repliesByID[key];
        if (
          !reply ||
          reply.segments.some((segment) => !acquired.current(segment.messageID))
        ) {
          throw missingMessage();
        }
        return reply.segments.flatMap((segment) => segment.parts.map(text))
          .filter(Boolean).join("\n\n");
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
        projection.releaseCommittedSends();
        open();
        setState((draft) => {
          draft.recovering = [];
        });
        range = undefined;
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
          acquired.visit(visible, visited);
        }
      }
      reserve();
    },
    async ensure(messageID, signal) {
      const lifetime = generation;
      while (
        selected && lifetime === generation && (state.loading || missing ||
          !projection.materialized(messageID) || !acquired.current(messageID))
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
        } else if (state.exhausted && !missing) {
          throw missingMessage();
        } else if (missing) await owner.latest(signal);
        else if (!state.gaps.length && acquired.next != null && !inFlight) {
          await paginate(
            undefined,
            undefined,
            () =>
              projection.materialized(messageID) && acquired.current(messageID),
          );
        } else await owner.older();
        if (state.pageError) throw feedbackError(state.pageError);
      }
      if (!selected || lifetime !== generation) {
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
        if (selected && missing && !fetching) void reacquireNewest("latest");
        inspect();
      });
    },
    reconcile(messageIDs) {
      const absent = () => messageIDs.some((id) => !projection.committed(id));
      if (!absent() && state.continuity === "ready") return Promise.resolve();
      if (reconciling) return reconciling;
      const work = (async () => {
        // Do not cancel a newest-page acquisition with another read of the same
        // boundary. Its canonical install can already cover this send.
        if (fetching) {
          await new Promise<void>((resolve) => {
            const release = subscribe(() => {
              if (!fetching || !selected) {
                release();
                resolve();
              }
            });
          });
        }
        if (selected && (absent() || missing)) await reacquireNewest("send");
      })();
      const pending = work.finally(() => {
        if (reconciling === pending) reconciling = undefined;
      });
      return reconciling = pending;
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
    refetch: () => reacquireNewest("retry", true),
    latestPrompt: () => state.latestPrompt,
    usesMetadata: (ids) =>
      ids.has(target.sessionID) || projection.usesMetadata(ids),
    receive(sidecarId: string, frame: ServerFrame): void {
      if (sidecarId !== target.sidecarId) return;
      if (frame.t === "harness") {
        const linked = frame.state === "connected";
        if (nativeConnected !== linked) {
          nativeConnected = linked;
          // Readiness changes even when last-good bodies and their clocks stay.
          setState(() => {});
        }
      }
      if (
        frame.t === "harness" && readFacts && readFacts.phase !== "ready"
      ) {
        readFacts = {
          ...readFacts,
          wait: frame.state === "connected"
            ? "waiting for the newest page"
            : "native unavailable",
        };
        readProgress.receive("page", readFacts);
      }
      const indexed = frame.t === "index.snapshot" || frame.t === "index.patch";
      const known = indexed ? entry(sidecarId, target.sessionID) : undefined;
      if (known?.deleted) {
        // The tab's choice survives cooling, but not deletion of a cold body.
        interaction.clear();
        retireScope?.(scope);
      }
      if (!selected || selected.sidecarId !== sidecarId) return;
      if (frame.t === "load.chunk") {
        const pending = boundaryRead;
        if (
          !pending || frame.epoch !== pending.epoch ||
          !connection(sidecarId).rpc.requests.matches(
            pending.intent,
            frame.request,
          ) ||
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
      if (indexed) {
        requests.retireSessions((id) => !!entry(sidecarId, id)?.deleted);
        const busyChanged = projection.busy(
          !!entities &&
            sessionRunning(entities, entityKey("session", target.sessionID)),
        );
        if (projection.helpers(helper) || busyChanged) {
          setState((draft) => {
            draft.content = attach(contentMetadata(draft.content));
          });
        }
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
        refreshAttention();
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
        sources.invalidate();
        missing = true;
        void reacquireNewest("invalidated");
        return;
      }
      if (frame.t === "welcome") {
        sources.invalidate();
        minimum = retriedVersion = undefined;
        void reacquireNewest("welcome");
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
          if (!entry(sidecarId, frame.sessionID)) refreshAttention();
          return;
        }
      } else if (frame.sessionID !== selected.sessionID) return;
      const previousClock = clock;
      try {
        if (frame.event.op === "part.upsert") notePart(frame.event.part, true);
        if (frame.event.op === "message.upsert") {
          baseline([frame.event.message]);
        }
        if (isAttentionOp(frame.event) && attentionReads) {
          const event = frame.event;
          const key = event.op === "question.upsert"
            ? event.request.id
            : event.op === "question.remove"
            ? event.requestID
            : undefined;
          if (key) {
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
          deliveryDiagnostics.record({
            ...target,
            operation: frame.event.op,
            previous: previousClock,
            state: "gap",
            reason: "Content publication has no clock",
          });
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
            deliveryDiagnostics.record({
              ...target,
              operation: frame.event.op,
              clock: frame.clock,
              previous: previousClock,
              state: "gap",
            });
            invalidate();
            return;
          }
          if (duplicate) return;
          if (
            state.temperature === "warm" &&
            frame.event.op === "message.upsert" &&
            !state.messagesByID[frame.event.message.id] &&
            (acquired.known(frame.event.message.id) ||
              (() => {
                const first = state.content.messages.at(
                  -MESSAGE_ADMISSION_WATERMARK,
                );
                return first !== undefined &&
                  compareMessages(frame.event.message, first) < 0;
              })())
          ) {
            // Only retained pages and the live tail own bodies; old identities do not resurrect their source.
            setState((draft) => {
              draft.clock = clock;
            });
            deliveryDiagnostics.record({
              ...target,
              operation: frame.event.op,
              clock,
              state: "accepted",
              ...(frame.event.op === "message.upsert"
                ? { messageID: frame.event.message.id }
                : {}),
            });
            return;
          }
          setState((draft) => {
            draft.content = apply(draft.content, frame.event);
            draft.clock = clock;
            if (frame.event.op === "message.remove" && draft.gaps.length) {
              publishGaps(draft);
            }
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
          lastClock = clock;
          if (
            frame.event.op === "message.upsert" ||
            frame.event.op === "message.remove"
          ) trim();
          deliveryDiagnostics.record({
            ...target,
            operation: frame.event.op,
            clock,
            state: "accepted",
            ...(frame.event.op === "message.upsert"
              ? { messageID: frame.event.message.id }
              : {}),
          });
        }
      } catch (cause) {
        deliveryDiagnostics.record({
          ...target,
          operation: frame.event.op,
          clock: frame.clock,
          previous: previousClock,
          state: "projection-error",
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        console.error("Transcript projection diagnostic", {
          ...target,
          clock: frame.clock,
          operation: frame.event.op,
        }, cause);
        invalidate();
      }
    },
    older(): Promise<void> {
      if (inFlight) return inFlight;
      if (repairingHead) return repairingHead;
      if (!selected || state.loading || state.paging) return Promise.resolve();
      if (state.gaps.length && !missing && acquired.ranges()[0]?.next != null) {
        return owner.bridge();
      }
      if (acquired.next !== undefined && !missing) return paginate();
      const lifetime = generation;
      const work = reacquireNewest("head-repair").then(() => {
        if (generation === lifetime && !missing && !state.pageError) {
          return owner.bridge();
        }
      }).finally(() => {
        if (repairingHead === work) repairingHead = undefined;
      });
      return repairingHead = work;
    },
    bridge(key) {
      if (inFlight) return inFlight;
      if (key && !state.gaps.some((gap) => gap.key === key)) {
        return Promise.resolve();
      }
      return paginate(state.gaps[0]?.key, key);
    },
    stop(): void {
      stopEntities?.();
      releaseRequests();
      snapshotLifetime.abort();
      readProgress.stop();
      interaction.clear();
      retireScope?.(scope);
      sources.stop();
      owner.temperature("cold");
    },
  };
  const paginate = (
    gapKey?: string,
    requested = gapKey,
    until?: () => boolean,
  ): Promise<void> => {
    const head = acquired.ranges()[0];
    if (
      !selected || state.loading || state.paging || missing || !head ||
      head.next == null
    ) {
      return Promise.resolve();
    }
    const limit = policy()?.bridgepages ?? 1;
    const target = selected,
      id = generation,
      request = load;
    let before = head.next;
    const retain = !automatic && !gapKey;
    if (retain) {
      for (const message of state.content.messages) visited.add(message.id);
    }
    setState((draft) => {
      draft.paging = true;
      draft.error = undefined;
      draft.pageError = undefined;
      bridging = gapKey ? { key: gapKey } : undefined;
      if (gapKey) publishGaps(draft);
    });
    const read = async () => {
      try {
        for (let i = 0; i < limit; i++) {
          const progressGeneration = `${id}:${request}:older:${
            before ?? "tail"
          }`;
          readLabel = "Loading earlier messages";
          readStage("queued", progressGeneration);
          const page = await readBoundary(
            before,
            controller!.signal,
            false,
            () => {
              readStage("reading", progressGeneration);
            },
          );
          if (!current(id, request)) return;
          if (boundaryRead) boundaryRead.deliver = undefined;
          if (page.load && !coverage(page.load)) {
            throw new Error("Invalid message coverage");
          }
          if (
            page.sessionID !== target.sessionID ||
            page.from.epoch !== page.clock.epoch ||
            page.from.seq > page.clock.seq ||
            page.clock.epoch !== clock?.epoch || !authority ||
            compareTranscriptVersion(page.version, authority) !== 0
          ) {
            invalidate();
            return;
          }
          const pageIDs = new Set(page.items.map(({ id }) => id));
          let loaded = { ...emptyContent(), messages: page.items };
          const tombstones = new Set<string>();
          const retained = firstRetained(), pageFirst = page.items[0];
          const first = retained &&
              (!pageFirst || compareMessages(retained, pageFirst) < 0)
            ? retained
            : pageFirst;
          for (const { event } of page.catchup) {
            if (event.op === "message.remove") tombstones.add(event.messageID);
            if (outsideAcquiredRange(event, first, page.older !== null)) {
              continue;
            }
            loaded = reduce(loaded, event);
          }
          // Catchup can carry off-page headers without their bodies. The live
          // stream owns current off-page rows even when the page clock is ahead.
          // On-page bodies still must not roll back current rows.
          const messages = loaded.messages.filter((message) =>
            !projection.materialized(message.id) ||
            !acquired.current(message.id) ||
            (pageIDs.has(message.id) && page.clock.seq >= clock!.seq)
          );
          const { deleted } = acquired.extend(
            head.key,
            before,
            page.older,
            page.items,
          );
          if (retain) {
            for (const message of messages) visited.add(message.id);
          }
          baseline(messages);
          const added = messages.some((m) => !projection.materialized(m.id));
          const gaps = acquired.gaps();
          const next = acquired.ranges()[0]?.next;
          let again = i + 1 < limit && next != null &&
            (requested ? gaps.some(({ key }) => key === requested) : !added);
          setState((draft) => {
            projection.reconcile(
              messages,
              page.catchup.length ? undefined : page,
            );
            let content = draft.content;
            for (const messageID of new Set([...deleted, ...tombstones])) {
              content = apply(content, { op: "message.remove", messageID });
            }
            projection.helpers(helper);
            projection.boundaries(
              Object.values(page.turns).map((turn) => turn.boundary),
            );
            const reread = new Set(messages.map(({ id }) => id));
            draft.content = attach({
              ...contentMetadata(content),
              recovering: [
                ...(content.recovering ?? []).filter(({ messageID }) =>
                  !reread.has(messageID)
                ),
                ...page.recovering.filter(({ messageID }) =>
                  reread.has(messageID)
                ),
              ],
            });
            if (until?.()) again = false;
            bridging = again && requested && gaps[0]
              ? { key: gaps[0].key }
              : undefined;
            publishGaps(draft);
            draft.paging = again;
          });
          if (!page.load || page.load.state === "complete") {
            readStage("ready", progressGeneration, page.items.length);
          }
          if (boundaryRead) boundaryRead.painted = true;
          finishCoverage();
          if (!again || next == null) return;
          before = next;
        }
      } catch (error) {
        if (current(id, request)) {
          setState((draft) => {
            draft.paging = false;
            draft.error = failureValue(error);
            draft.pageError = draft.error;
            if (bridging) {
              bridging = { key: bridging.key, failure: draft.error };
            }
            publishGaps(draft);
          });
        }
      }
    };
    const work = read().finally(() => {
      if (inFlight === work) inFlight = undefined;
    });
    inFlight = work;
    return work;
  };
  const refreshWork = () => {
    if (
      projection.busy(
        !!entities &&
          sessionRunning(entities, entityKey("session", target.sessionID)),
      )
    ) {
      setState((draft) => {
        draft.content = attach(contentMetadata(draft.content));
      });
    }
  };
  const stopEntities = entities?.observeChanges((keys) => {
    if (
      keys === "all" || keys.includes(entityKey("session", target.sessionID))
    ) refreshWork();
  });
  refreshWork();
  return owner;
}
