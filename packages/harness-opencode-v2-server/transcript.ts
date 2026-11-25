// SPDX-License-Identifier: LGPL-3.0-only
import { ContentReplay, HarnessError } from "@otk/harness";
import type { DigestPort } from "@otk/harness";
import { StreamBuffers } from "@otk/content";
import {
  compareMessages,
  isAssistantTerminal,
  isRealPrompt,
  knownDerived,
  MAX_MESSAGE_CURSOR_LENGTH,
  MESSAGE_PAGE_SIZE,
  OperationFailure,
  outcomeTime,
  sessionErrorMessage,
  sourceAt,
} from "@otk/protocol";
import type {
  ContentOp,
  LatestPrompt,
  Message,
  MessagePage,
  MessagePolicy,
  RevertCommit,
  RevertCommitCapability,
  TranscriptInvalidation,
} from "@otk/protocol";
import { errorTag, type V2Client, V2MissingSession } from "./client.ts";
import {
  eventMessage,
  knownSessionEvent,
  Messages,
  nativeCursor,
  nativeForwardCursor,
  type NativeMessage,
  type NativeSession,
  SCAN_ROWS,
} from "./messages.ts";
import {
  assistantSettled,
  completeTokens,
  deriveInboxMessage,
  inboxMessage,
  lifecycleRecord,
  mapMessage,
  mapSession,
  type MessageContext,
  millis,
  partID,
  record,
  requestOutcome,
  text,
} from "./map.ts";
import { mapTool } from "./tool-interpretation.ts";
import { requestFailureRecord } from "./request-failure.ts";
import {
  nativeSource,
  parseSourceRef,
  referenced,
  sourceFailure,
} from "./native-source.ts";
import {
  positionOrder,
  type RequestPosition,
  type RequestRetention,
  V2RequestRetention,
} from "./request-retention.ts";
import {
  type NativeHead,
  type PrefetchInput,
  type PrefetchPage,
  type TranscriptFacts,
  type TranscriptInput,
  TranscriptReads,
} from "./transcript-reads.ts";
import { MessagePrefetchCache } from "./prefetch.ts";
import { MessageRecovery } from "./recovery.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import type { V2Event } from "./stream.ts";
import { revertSession } from "./session-actions.ts";
import { AgentColors } from "./agent-colors.ts";
interface Baseline {
  raw: NativeSession;
  epoch: string;
  controller: AbortController;
  prompt?: LatestPrompt;
  contexts: Map<string, MessageContext>;
  /** Monotone API presentation frontier; events never scan acquired history. */
  order?: number;
  source?: string;
  presentation?: import("@otk/protocol").ContentSession;
  notices?: import("@otk/protocol").PublicFailure[];
}
interface Cursor {
  v: 3;
  session: string;
  epoch: string;
  cutoff: string | null;
  native: string;
  source: string;
  retained?: { created: number; id: string; order?: number };
  revision: number;
  unanchored?: {
    before?: { created: number; id: string };
    pending: string[];
    exhausted: boolean;
  };
  reuse?: boolean;
  snapshot?: true;
}
interface LiveShell {
  session: string;
  raw: Extract<NativeMessage, { type: "shell" }>;
  context: MessageContext;
  location: { directory: string };
  controller: AbortController;
  task: Promise<void>;
}
interface HistoryCheck {
  pending?: boolean;
  anchor?: string;
  head?: NativeHead;
  checkpoint?: NativeHead;
  controller: AbortController;
  task?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  dirty: boolean;
  targets: Set<string>;
}
/** API snapshots and staged events describe the same boundary, including file mode. */
function boundaryKey(revert: unknown): string {
  const value = record(revert);
  return JSON.stringify([
    text(value.messageID) ?? null,
    text(value.partID) ?? null,
    text(value.snapshot) ?? null,
    Array.isArray(value.files)
      ? value.files.map((raw) => {
        const file = record(raw);
        return [
          file.file,
          file.patch,
          file.additions,
          file.deletions,
          file.status,
          file.more,
        ];
      })
      : null,
  ]);
}
const encode = (value: Cursor) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
function cursorEdge(value: unknown, sequence: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return Object.keys(edge).every((key) =>
    ["created", "id", ...(sequence ? ["order"] : [])].includes(key)
  ) &&
    Number.isFinite(edge.created) && typeof edge.id === "string" &&
    (edge.order === undefined || Number.isFinite(edge.order));
}
function decode(token: string): Cursor {
  try {
    if (
      !token || token.length > MAX_MESSAGE_CURSOR_LENGTH ||
      !/^[\w-]+$/.test(token)
    ) throw new Error();
    const v = JSON.parse(atob(token.replaceAll("-", "+").replaceAll("_", "/")));
    if (
      Object.keys(v).some((key) =>
        ![
          "v",
          "session",
          "epoch",
          "cutoff",
          "native",
          "source",
          "retained",
          "revision",
          "unanchored",
          "reuse",
          "snapshot",
        ].includes(key)
      ) ||
      v.v !== 3 || typeof v.session !== "string" ||
      typeof v.epoch !== "string" || typeof v.native !== "string" ||
      (!v.native && !v.retained && !v.unanchored) ||
      typeof v.source !== "string" || !v.source ||
      !Number.isSafeInteger(v.revision) || v.revision < 0 ||
      (v.reuse !== undefined && typeof v.reuse !== "boolean") ||
      (v.snapshot !== undefined && v.snapshot !== true) ||
      (v.retained !== undefined &&
        !cursorEdge(v.retained, true)) ||
      (v.unanchored !== undefined && (
        !v.unanchored || typeof v.unanchored !== "object" ||
        Array.isArray(v.unanchored) ||
        Object.keys(v.unanchored).some((key) =>
          !["before", "pending", "exhausted"].includes(key)
        ) ||
        typeof v.unanchored.exhausted !== "boolean" ||
        !Array.isArray(v.unanchored.pending) ||
        v.unanchored.pending.length > MESSAGE_PAGE_SIZE ||
        v.unanchored.pending.some((id: unknown) =>
          typeof id !== "string" || !id
        ) ||
        new Set(v.unanchored.pending).size !== v.unanchored.pending.length ||
        (v.unanchored.before !== undefined &&
          !cursorEdge(v.unanchored.before, false))
      )) ||
      (v.source.startsWith("sql") !== (v.unanchored !== undefined)) ||
      v.source.length > 512 ||
      (v.cutoff !== null && typeof v.cutoff !== "string")
    ) throw new Error();
    return v;
  } catch {
    throw new HarnessError(
      "cursor-stale",
      "Message continuation is no longer valid. Refresh messages.",
    );
  }
}
/** One demand-owned transcript lifetime for pages, source, recovery and prefetch. */
export class Transcript {
  readonly colors?: AgentColors;
  readonly buffers: StreamBuffers = new StreamBuffers();
  readonly replay: ContentReplay;
  readonly reader: Messages;
  readonly recovery: MessageRecovery;
  #baselines = new Map<string, Baseline>();
  #opening = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<Baseline>;
      users: number;
      settled: boolean;
    }
  >();
  #subscriptions = new Set<string>();
  #live = new Map<
    string,
    {
      session: string;
      raw: Extract<NativeMessage, { type: "assistant" }>;
      context: MessageContext;
    }
  >();
  #cache?: MessagePrefetchCache;
  #prefetch = new Map<
    string,
    { session: string; controller: AbortController; task: Promise<void> }
  >();
  #lifetime = new AbortController();
  #revisions = 0;
  /** Last durable sequence per session aggregate delivered on this connection. */
  #watermarks = new Map<string, number>();
  /** Observations awaiting the next durable event of their session, in order. */
  #anchors = new Map<string, string[]>();
  #client?: V2Client;
  #shells = new Map<string, LiveShell>();
  #shellLookups = new Map<
    string,
    { session: string; event: V2Event; controller: AbortController }
  >();
  #releaseShellLookups(id?: string): void {
    for (const [key, work] of this.#shellLookups) {
      if (id !== undefined && work.session !== id) continue;
      this.#shellLookups.delete(key);
      work.controller.abort();
    }
  }
  #projected = new Map<
    string,
    { shells: Map<string, string> }
  >();
  /** Live lifecycle authority, never replaced by historical mapping. */
  #compactions = new Map<
    string,
    Extract<NativeMessage, { type: "compaction" }>
  >();
  #finished = new Map<string, Map<string, { start?: number; at?: number }>>();
  #boundaries = new Map<string, string>();
  #revertCommits = new Map<string, RevertCommit>();
  readonly revertCommit: RevertCommitCapability = {
    latest: (id) => this.#revertCommits.get(id),
  };
  /** Kinds of observed queued inbox items, by session and inbox ID. */
  #queued = new Map<string, Map<string, string>>();
  #tasks = new Set<Promise<unknown>>();
  #checking = false;
  /** Scalar coverage only. Canonical bodies remain in native history. */
  #history = new Map<string, HistoryCheck>();
  #backfills = new Map<string, AbortController>();
  #cancelBackfills(id?: string): void {
    for (const [session, controller] of this.#backfills) {
      if (id !== undefined && session !== id) continue;
      this.#backfills.delete(session);
      controller.abort();
    }
  }
  #helperLinks = new Map<
    string,
    {
      parent: string;
      message: string;
      part: string;
      child: string;
      revision: number;
    }
  >();
  #helperHints = new Set<string>();
  #helperReads = new Map<
    string,
    { controller: AbortController; dirty: boolean }
  >();
  #helperProgress = new Map<string, import("@otk/protocol").HelperSummary>();
  #own<T>(task: Promise<T>): Promise<T> {
    this.#tasks.add(task);
    void task.then(
      () => this.#tasks.delete(task),
      () => this.#tasks.delete(task),
    );
    return task;
  }
  start(): void {
    if (this.#lifetime.signal.aborted) this.#lifetime = new AbortController();
    this.#checking = true;
    for (const [id, work] of this.#history) this.#armHistory(id, work);
  }
  #releaseHistory(id?: string): void {
    for (const [key, work] of this.#history) {
      if (id !== undefined && key !== id) continue;
      this.#history.delete(key);
      clearTimeout(work.timer);
      work.controller.abort();
    }
  }
  #armHistory(id: string, work: HistoryCheck): void {
    if (
      !this.#checking || work.timer !== undefined || work.task ||
      work.pending ||
      this.#history.get(id) !== work || !this.#subscriptions.has(id)
    ) return;
    work.timer = setTimeout(() => {
      work.timer = undefined;
      void this.check(id).catch(this.options.diagnostic);
    }, this.options.policy.retryms);
  }
  #seedHistory(id: string, anchor?: string): void {
    if (!this.#subscriptions.has(id)) return;
    // Only a new native tail page moves the acquisition frontier. Live upserts
    // cannot certify the missing interval before them.
    let work = this.#history.get(id);
    if (!work) {
      work = {
        anchor,
        controller: new AbortController(),
        dirty: false,
        targets: new Set(),
      };
      this.#history.set(id, work);
    }
    if (work.pending) {
      work.pending = false;
      work.anchor = anchor;
    }
    this.#armHistory(id, work);
  }
  #repairHistory(id: string, target?: string): void {
    const work = this.#history.get(id);
    if (!work) {
      this.#publish(id, { op: "stream.reconcile" });
      return;
    }
    work.dirty = true;
    if (target) work.targets.add(target);
    if (work.pending) return;
    else this.#publish(id, { op: "stream.reconcile" });
    // Repairs are owned and joined, but never wait in the serial SSE handler.
    queueMicrotask(() => {
      void this.check(id).catch(this.options.diagnostic);
    });
  }
  /** Compare native history, independently of native-event dispatch progress. */
  check(id: string): Promise<void> {
    const work = this.#history.get(id), baseline = this.#baselines.get(id);
    if (!work || work.pending || !baseline || !this.#subscriptions.has(id)) {
      return Promise.resolve();
    }
    if (work.task) return work.task;
    clearTimeout(work.timer);
    work.timer = undefined;
    const signal = AbortSignal.any([
      work.controller.signal,
      baseline.controller.signal,
      this.#lifetime.signal,
    ]);
    let retryTargets: string[] = [];
    const task = this.#own(
      (async () => {
        do {
          const forced = work.dirty, targets = [...work.targets];
          retryTargets = targets;
          work.dirty = false;
          work.targets.clear();
          const cutoff = baseline.raw.revert?.messageID;
          let head = this.options.digest
            ? await this.options.digest.read("opcv2.transcript.head", {
              sessionID: id,
              cutoff,
            }, {
              owner: `v2-history:${id}`,
              priority: "user",
              signal,
            })
            : null;
          let last: NativeMessage | undefined;
          if (!head) {
            last = (await this.reader.page(
              id,
              1,
              cutoff ? nativeCursor(cutoff) : undefined,
              signal,
            )).items.at(-1);
            head = last ? { id: last.id } : null;
          }
          signal.throwIfAborted();
          if (!head) {
            if (work.anchor) this.invalidate(id);
            return;
          }
          if (
            !forced && work.head &&
            JSON.stringify(work.head) === JSON.stringify(head)
          ) continue;
          const publish = async (rows: NativeMessage[]) => {
            const facts = await this.#facts({
              sessionID: id,
              messages: rows.map((r) => r.id),
              cutoff,
            }, signal);
            signal.throwIfAborted();
            this.#acceptFacts(baseline, facts);
            for (const raw of rows) {
              // Fine replacement owns its missing source, including failed
              // checkpoints. History discovery cannot become an implicit Retry.
              if (this.recovery.owns(id, raw.id)) continue;
              const context = facts.contexts[raw.id];
              if (!context) {
                throw new HarnessError(
                  "capture-stale",
                  "Native history changed during repair",
                );
              }
              if (raw.type === "idle" && raw.outcome === "failed") {
                await this.#executionFailure(
                  id,
                  raw.id,
                  raw.error,
                  millis(raw.time.created),
                  context,
                  baseline.raw.title,
                  facts.source.startsWith("sql") ? context.order : undefined,
                  signal,
                );
              } else {
                const message = this.#map(raw, id, context);
                if (message) {
                  this.#publish(id, { op: "message.upsert", message });
                }
              }
            }
          };
          // In-place changes may target an older, acquired native identity.
          for (const target of targets) {
            if (
              baseline.contexts.has(target) && !this.recovery.owns(id, target)
            ) {
              await publish([
                await this.reader.get(id, target, signal),
              ]);
            }
          }
          let anchor: NativeMessage | undefined;
          try {
            anchor = !work.anchor
              ? undefined
              : last?.id === work.anchor
              ? last
              : this.recovery.owns(id, work.anchor) ||
                  work.checkpoint?.id === work.anchor &&
                    (head.id !== work.anchor ||
                      JSON.stringify(work.checkpoint) === JSON.stringify(head))
              ? undefined
              : await this.reader.get(id, work.anchor, signal);
          } catch (error) {
            if (errorTag(error) !== "MessageNotFoundError") throw error;
            // Removal/revert changes the acquisition boundary too. Its canonical
            // page must reacquire the session header, not reuse this old cutoff.
            this.invalidate(id);
            return;
          }
          if (anchor) await publish([anchor]);
          if (
            !work.anchor ||
            (this.#client ?? this.options.client()).service.version !== "2.2.6"
          ) {
            let cursor: string | undefined = cutoff
              ? nativeCursor(cutoff)
              : undefined;
            do {
              const page = await this.reader.page(
                id,
                SCAN_ROWS,
                cursor,
                signal,
              );
              const at = page.items.findIndex((r) => r.id === anchor?.id);
              await publish(at < 0 ? page.items : page.items.slice(at + 1));
              if (at >= 0 || !page.next) break;
              if (page.next === cursor) {
                throw new HarnessError(
                  "capture-stale",
                  "Native history cursor did not advance",
                );
              }
              cursor = page.next;
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            } while (true);
          } else if (work.anchor !== head.id) {
            let cursor: string | undefined = nativeForwardCursor(work.anchor);
            do {
              const page = await this.reader.forward(id, cursor, signal);
              const end = page.items.findIndex((r) => r.id === head.id);
              // Seal only the head observed above. Later native appends belong to
              // the next check; staged reverts never acquire their hidden suffix.
              await publish(
                end < 0 ? page.items : page.items.slice(0, end + 1),
              );
              if (end >= 0) break;
              if (!page.next || page.next === cursor) {
                throw new HarnessError(
                  "capture-stale",
                  "Native history head changed during repair",
                );
              }
              cursor = page.next;
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            } while (true);
          }
          signal.throwIfAborted();
          work.anchor = head.id;
          work.head = head;
          retryTargets = [];
        } while (work.dirty);
      })().catch((error) => {
        if (signal.aborted) return;
        work.dirty = true;
        for (const target of retryTargets) work.targets.add(target);
        // A failed observation is not a complete empty transcript. The canonical
        // read owner surfaces failure and retries; preserve existing content.
        this.#publish(id, { op: "stream.reconcile" });
        throw error;
      }).finally(() => {
        work.task = undefined;
        this.#armHistory(id, work);
      }),
    );
    work.task = task;
    return task;
  }
  readonly requests: RequestRetention;
  #executionFailures = new Map<string, Promise<Message>>();
  constructor(
    readonly options: {
      client(): V2Client;
      policy: MessagePolicy;
      digest?: DigestPort;
      requests?: RequestRetention;
      /** Keyed native sequence probe: latest message, or one message's. */
      sequence?(
        input: { sessionID: string; messageID?: string },
        signal: AbortSignal,
      ): Promise<number | undefined>;
      facts?(
        input: TranscriptInput,
        signal: AbortSignal,
      ): Promise<TranscriptFacts>;
      prefetch?(
        input: PrefetchInput,
        signal: AbortSignal,
      ): Promise<PrefetchPage>;
      content(
        session: string,
        event: ContentOp,
        clock?: import("@otk/protocol").ContentClock,
      ): void;
      invalidated(value: TranscriptInvalidation): void;
      diagnostic(error: unknown): void;
      /** Live context recovery enriches an existing observation, never an archive read. */
      recoveredFailure?(
        id: string,
        failure: import("@otk/protocol").PublicFailure,
      ): void;
      summaries?(
        id: string,
        turns: readonly string[],
      ): Record<
        string,
        import("@otk/protocol").Derived<import("@otk/protocol").UsageSummary>
      >;
      helper?(id: string): import("@otk/protocol").HelperSummary | undefined;
      requestHelper?(id: string): void;
      agents?(
        directory: string,
        signal: AbortSignal,
      ): Promise<readonly import("@otk/protocol").CatalogAgent[]>;
    },
  ) {
    this.requests = options.requests ?? new V2RequestRetention();
    if (options.agents) {
      this.colors = new AgentColors(
        options.agents,
        (id, colors) => this.#publish(id, { op: "agent.colors", colors }),
        options.diagnostic,
      );
    }
    this.reader = new Messages(() => this.#client ?? options.client());
    this.replay = new ContentReplay({
      ...options.policy,
      nonce: () => crypto.randomUUID(),
      emit: options.content,
    });
    if (
      options.policy.prefetchms !== undefined &&
      options.policy.prefetchbytes !== undefined
    ) {
      this.#cache = new MessagePrefetchCache({
        prefetchms: options.policy.prefetchms,
        prefetchbytes: options.policy.prefetchbytes,
      });
    }
    this.recovery = new MessageRecovery({
      concurrency: options.policy.recoveryconcurrency,
      pending: options.policy.recoverypending,
      wanted: (id) => this.#subscriptions.has(id),
      read: async (id, message, signal) => {
        const work = this.#history.get(id);
        let witness: NativeHead | null = null;
        if (work && this.options.digest) {
          try {
            // Capture before the body read: a later native edit must advance
            // this witness and remain visible to history's ordinary repair.
            witness = await this.options.digest.read("opcv2.transcript.head", {
              sessionID: id,
              cutoff: this.#baselines.get(id)?.raw.revert?.messageID,
            }, { owner: `v2-recovery:${id}`, priority: "user", signal });
          } catch (error) {
            signal.throwIfAborted();
            this.options.diagnostic(error);
          }
        }
        const raw = await this.reader.get(id, message, signal);
        signal.throwIfAborted();
        if (work && this.#history.get(id) === work && witness?.id === message) {
          work.checkpoint = witness;
        }
        return raw;
      },
      emit: async (id, raw, _parts, _generation, terminal, signal) => {
        const baseline = await this.#baseline(id, signal),
          facts = await this.#facts({
            sessionID: id,
            messages: [raw.id],
            cutoff: baseline.raw.revert?.messageID,
          }, signal);
        signal.throwIfAborted();
        const context = facts.contexts[raw.id];
        if (!context) return;
        if (
          terminal && raw.type === "assistant" && !assistantSettled(raw) &&
          !context.terminal && !this.#finished.get(id)?.has(raw.id)
        ) {
          throw new Error("Native response checkpoint is not settled yet");
        }
        const mapped = this.#map(raw, id, context, terminal, true);
        if (mapped) {
          this.#publish(id, { op: "message.upsert", message: mapped });
        }
      },
      state: (id, messageID, partID, generation, state) =>
        this.#publish(id, {
          op: "stream.recovery",
          messageID,
          partID,
          generation,
          state,
        }),
      reconcile: (id) => this.#publish(id, { op: "stream.reconcile" }),
      failed: options.diagnostic,
    });
  }
  /** Derives one referenced source again from the owner that minted it. */
  async source(
    id: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<import("@otk/protocol").NativeSourceView> {
    let value: ReturnType<typeof parseSourceRef>;
    try {
      value = parseSourceRef(ref);
    } catch {
      throw sourceFailure("reference");
    }
    let derived: Message | undefined;
    if (value.origin === "request" || value.origin === "record") {
      derived = (await this.requests.get(id, value.id))?.outcome;
      if (!derived) throw sourceFailure(value.origin);
    } else {
      try {
        if (value.origin === "inbox") {
          const inbox = await this.reader.inbox(id, signal);
          if (inbox.state === "unsupported") throw sourceFailure("inbox");
          const row = inbox.items.find((row) => row.id === value.id);
          if (!row) throw sourceFailure("inbox");
          derived = deriveInboxMessage(
            row.id,
            row as unknown as Record<string, unknown>,
            millis(row.time.created),
            id,
            { order: 0 },
          );
        } else {
          const live = this.#live.get(value.id);
          const shell = [...this.#shells.values()].find((owner) =>
            owner.session === id && owner.raw.id === value.id
          );
          let raw = live?.session === id
            ? live.raw
            : shell?.raw ?? await this.reader.get(id, value.id, signal);
          if (raw.type === "assistant") {
            const ordinals = { text: 0, reasoning: 0 };
            const terminal = raw.time.completed != null;
            raw = {
              ...raw,
              content: raw.content.map((part) => {
                if (
                  part.type !== "text" && part.type !== "reasoning" || terminal
                ) return part;
                const acquired = this.buffers.source(
                  partID(raw.id, part.type, ordinals[part.type]++),
                  id,
                  raw.id,
                  part.text,
                );
                return acquired === undefined
                  ? part
                  : { ...part, text: acquired };
              }),
            };
          }
          derived = mapMessage(
            raw,
            id,
            live?.session === id
              ? live.context
              : shell?.context ?? { order: 0 },
          );
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof HarnessError && error.code.startsWith("source.")) {
          throw error;
        }
        throw sourceFailure(
          error instanceof V2MissingSession ||
            /NotFound/.test(errorTag(error) ?? "")
            ? "message"
            : error instanceof OperationFailure &&
                error.outcome === "unavailable"
            ? "unreachable"
            : "read",
        );
      }
    }
    signal.throwIfAborted();
    const view = sourceAt(derived, value.path);
    if (!view) throw sourceFailure("item");
    return view;
  }
  #assistantContext(
    id: string,
    messageID: string,
    context: MessageContext,
    parentID?: string,
    admitting = false,
  ): MessageContext {
    const baseline = this.#baselines.get(id);
    const accepted = baseline?.contexts.get(messageID);
    const nativeParent = parentID ?? context.nativeParent ??
      this.#live.get(messageID)?.context.nativeParent ?? accepted?.nativeParent;
    const replyTo = nativeParent ?? accepted?.replyTo ??
      context.replyTo ?? (admitting ? baseline?.prompt?.id : undefined);
    const result = {
      ...context,
      replyTo,
      ...(nativeParent ? { nativeParent } : {}),
    };
    if (nativeParent) this.#context(baseline, messageID, result);
    return result;
  }
  #causalEvent(id: string, event: ContentOp): ContentOp {
    if (event.op !== "message.upsert" || event.message.role !== "assistant") {
      return event;
    }
    const message = event.message;
    const context = this.#assistantContext(id, message.id, {
      order: message.sourceOrder ?? message.time.created,
      replyTo: message.replyTo,
    });
    return context.replyTo === message.replyTo ? event : {
      ...event,
      message: { ...message, replyTo: context.replyTo },
    };
  }
  #publish(id: string, event: ContentOp): void {
    if (!this.#subscriptions.has(id) || this.#lifetime.signal.aborted) {
      this.replay.delivery.record({
        sessionID: id,
        operation: event.op,
        state: "unsubscribed",
        ...(event.op === "message.upsert"
          ? { messageID: event.message.id }
          : {}),
      });
      return;
    }
    if (this.#subscriptions.has(id) && !this.#lifetime.signal.aborted) {
      event = this.#causalEvent(id, event);
      if (event.op === "message.upsert") {
        event = {
          ...event,
          message: referenced(
            this.#decorateAgent(event.message, id),
            event.message.id,
          ),
        };
      } else if (event.op === "part.upsert") {
        event = { ...event, part: referenced(event.part, event.messageID) };
      }
      this.replay.publish(id, event);
    }
  }
  /** Diagnostics share the transcript clock and page catchup with body events. */
  error(id: string, state: import("@otk/protocol").SessionErrorState): void {
    this.#publish(id, {
      op: "session.error",
      errorState: state,
      error: sessionErrorMessage(state),
    });
  }
  #decorateAgent(message: Message, id: string): Message {
    const directory = this.#baselines.get(id)?.raw.location.directory;
    if (!directory || !this.#subscriptions.has(id)) return message;
    const colors = this.colors?.peek(id, directory);
    return message.role !== "context" && message.agent
      ? { ...message, agentColor: colors?.[message.agent] }
      : message;
  }
  async #facts(
    input: TranscriptInput,
    signal: AbortSignal,
    reader = this.reader,
  ): Promise<TranscriptFacts> {
    if (this.options.facts) return await this.options.facts(input, signal);
    if (this.options.digest) {
      return await this.options.digest.read("opcv2.transcript", input, {
        owner: `v2-transcript:${input.sessionID}`,
        priority: "user",
        signal,
      });
    }
    return await new TranscriptReads(reader, () => undefined).facts(
      input,
      signal,
    );
  }
  #key(id: string, baseline: Baseline, before: string): string {
    return JSON.stringify([
      this.replay.version(id),
      id,
      baseline.epoch,
      baseline.raw.revert?.messageID ?? null,
      before,
      MESSAGE_PAGE_SIZE,
    ]);
  }
  #context(
    baseline: Baseline | undefined,
    id: string,
    context: MessageContext,
  ): void {
    if (!baseline) return;
    baseline.contexts.set(id, context);
    baseline.order = Math.max(baseline.order ?? 0, context.order);
  }
  #acceptFacts(baseline: Baseline, facts: TranscriptFacts): void {
    if (baseline.source && baseline.source !== facts.source) {
      this.invalidate(ids.encode(baseline.raw.id));
      throw new HarnessError(
        "cursor-stale",
        "Message source changed. Refresh messages.",
      );
    }
    baseline.source = facts.source;
    if (facts.source.startsWith("api")) {
      const anchor = Object.entries(facts.contexts).find(([id]) =>
        baseline.contexts.has(id)
      );
      if (anchor) {
        const shift = baseline.contexts.get(anchor[0])!.order - anchor[1].order;
        for (const ctx of Object.values(facts.contexts)) ctx.order += shift;
        if (facts.cutoffOrder !== undefined) facts.cutoffOrder += shift;
      }
    }
    // Scalar native context is authoritative before the page/replay is sealed.
    // A live step can have arrived while this first capture was still reading.
    baseline.prompt = facts.metadata.prompt;
    for (const [id, context] of Object.entries(facts.contexts)) {
      const live = this.#live.get(id);
      const nativeParent = baseline.contexts.get(id)?.nativeParent ??
        live?.context.nativeParent;
      const accepted = nativeParent
        ? { ...context, replyTo: nativeParent, nativeParent }
        : context;
      this.#context(baseline, id, accepted);
      if (live && accepted.replyTo && (!live.context.replyTo || nativeParent)) {
        live.context = {
          ...live.context,
          replyTo: accepted.replyTo,
          ...(nativeParent ? { nativeParent } : {}),
        };
      }
    }
  }
  changed(id?: string): void {
    this.#cache?.clear(id);
    for (const [key, work] of this.#prefetch) {
      if (id !== undefined && work.session !== id) continue;
      this.#prefetch.delete(key);
      work.controller.abort();
    }
  }
  #next(id: string, baseline: Baseline, before?: string): void {
    if (
      !before || !this.#cache ||
      (!this.options.prefetch && !this.options.digest)
    ) return;
    const key = this.#key(id, baseline, before);
    if (this.#cache.get(key) || this.#prefetch.has(key)) return;
    const controller = new AbortController(),
      input = {
        sessionID: id,
        messages: [],
        before,
        limit: MESSAGE_PAGE_SIZE,
        cutoff: baseline.raw.revert?.messageID,
      };
    const work = { session: id, controller, task: Promise.resolve() };
    this.#prefetch.set(key, work);
    const read = this.options.prefetch
      ? this.options.prefetch(input, controller.signal)
      : this.options.digest!.read("opcv2.message.prefetch", input, {
        owner: `v2-prefetch:${id}`,
        priority: "background",
        optional: true,
        signal: controller.signal,
      });
    work.task = this.#own(
      read.then((value) => {
        if (
          this.#prefetch.get(key) === work &&
          this.#baselines.get(id) === baseline &&
          key === this.#key(id, baseline, before)
        ) this.#cache!.put(id, key, value);
      }).catch(() => {}).finally(() => {
        if (this.#prefetch.get(key) === work) this.#prefetch.delete(key);
      }),
    );
  }
  subscriptions(id: string, count: number): void {
    ids.decode(id);
    this.buffers.subscriptions(id, count);
    if (count > 0) {
      this.#subscriptions.add(id);
      this.buffers.epoch(id, this.replay.clock(id).epoch);
    } else {
      this.#subscriptions.delete(id);
      this.release(id, true);
    }
  }
  release(id?: string, retainLive = false): void {
    this.#releaseShellLookups(id);
    this.#releaseHistory(id);
    this.colors?.release(id);
    this.#cancelBackfills(id);
    this.changed(id);
    this.recovery.release(id);
    if (id === undefined) this.#finished.clear();
    else this.#finished.delete(id);
    if (id === undefined) this.#boundaries.clear();
    else this.#boundaries.delete(id);
    this.#releaseHelpers(id);
    for (const [key, shell] of this.#shells) {
      if (id === undefined || shell.session === id) {
        this.#shells.delete(key);
        shell.controller.abort();
      }
    }
    if (id === undefined) this.#projected.clear();
    else this.#projected.delete(id);
    if (id === undefined) this.#compactions.clear();
    else this.#compactions.delete(id);
    if (id === undefined) this.#queued.clear();
    else this.#queued.delete(id);
    for (const [key, owner] of this.#opening) {
      if (id === undefined || key === id) {
        this.#opening.delete(key);
        owner.controller.abort();
      }
    }
    for (const [key, baseline] of this.#baselines) {
      if (id === undefined || key === id) {
        this.#baselines.delete(key);
        baseline.controller.abort();
      }
    }
    for (const [key, value] of this.#live) {
      if (!retainLive && (id === undefined || value.session === id)) {
        this.#live.delete(key);
      }
    }
    if (id === undefined) this.buffers.reset();
    else if (!retainLive) this.buffers.removeSession(id);
    this.replay.reset(id);
    if (id) this.options.digest?.release(`v2-prefetch:${id}`);
  }
  invalidate(id?: string, retain = false): void {
    this.#releaseShellLookups(id);
    this.#releaseHistory(id);
    this.#cancelBackfills(id);
    this.changed(id);
    this.recovery.release(id);
    this.#releaseHelpers(id);
    for (const [key, shell] of this.#shells) {
      if (id === undefined || shell.session === id) {
        this.#shells.delete(key);
        shell.controller.abort();
      }
    }
    if (id === undefined) this.#projected.clear();
    else this.#projected.delete(id);
    if (id === undefined) this.#compactions.clear();
    else this.#compactions.delete(id);
    if (id === undefined) this.#queued.clear();
    else this.#queued.delete(id);
    for (const [key, owner] of this.#opening) {
      if (id === undefined || key === id) {
        this.#opening.delete(key);
        owner.controller.abort();
      }
    }
    for (const [key, baseline] of this.#baselines) {
      if (id === undefined || key === id) {
        this.#baselines.delete(key);
        baseline.controller.abort();
      }
    }
    if (!retain) {
      if (id === undefined) this.#finished.clear();
      else this.#finished.delete(id);
      if (id) this.buffers.removeSession(id);
      else this.buffers.reset();
      for (const [key, value] of this.#live) {
        if (id === undefined || value.session === id) this.#live.delete(key);
      }
    }
    const notice = this.replay.invalidate(id);
    this.options.invalidated(notice);
    if (retain) {
      this.buffers.rebind(
        (key) => this.replay.clock(key).epoch,
        (session, message, part) => this.recovery.touch(session, message, part),
      );
    }
  }
  disconnect(): void {
    this.#releaseShellLookups();
    this.#releaseHistory();
    // Undelivered events are missed by contract; watermarks are per connection.
    // Unresolved observations keep their probed (or clock) position.
    this.#watermarks.clear();
    this.#anchors.clear();
    this.colors?.reset();
    this.#cancelBackfills();
    this.#releaseHelpers();
    this.buffers.suspend();
    this.changed();
    this.recovery.release();
    for (const shell of this.#shells.values()) shell.controller.abort();
    this.#shells.clear();
    // With no viewer, a broken native stream ends the retained append lease.
    // Reconnect must not acquire bodies merely to settle an unviewed cache.
    for (const [key, live] of this.#live) {
      if (!this.#subscriptions.has(live.session)) {
        this.#live.delete(key);
        this.buffers.removeMessage(key, live.session);
      }
    }
  }
  observe(raw: NativeSession): void {
    const id = ids.encode(raw.id), baseline = this.#baselines.get(id);
    this.changed(id);
    const changed = this.#boundary(id, raw.revert);
    if (changed && baseline) {
      this.#baselines.set(id, {
        raw,
        epoch: this.replay.clock(id).epoch,
        controller: new AbortController(),
        contexts: new Map(),
      });
    } else if (baseline) {
      baseline.raw = raw;
      baseline.presentation = undefined;
    }
  }
  #boundary(id: string, revert: unknown, force = false): boolean {
    const key = boundaryKey(revert);
    const changed = this.#boundaries.has(id)
      ? this.#boundaries.get(id) !== key
      : key !== boundaryKey(undefined);
    this.#boundaries.set(id, key);
    if (changed || force) this.invalidate(id);
    return changed || force;
  }
  async #baseline(id: string, signal: AbortSignal): Promise<Baseline> {
    ids.decode(id);
    signal.throwIfAborted();
    const existing = this.#baselines.get(id);
    if (existing) return existing;
    let owner = this.#opening.get(id);
    if (!owner) {
      const controller = new AbortController(),
        epoch = this.replay.clock(id).epoch;
      const opening = {
        controller,
        users: 0,
        settled: false,
        promise: Promise.resolve(undefined as unknown as Baseline),
      };
      this.#opening.set(id, opening);
      opening.promise = this.#own(
        this.reader.client().read(
          (api) =>
            api.session.get({ sessionID: ids.decode(id) }, {
              signal: controller.signal,
            }),
          controller.signal,
        ).then((raw) => {
          controller.signal.throwIfAborted();
          if (epoch !== this.replay.clock(id).epoch) {
            throw new HarnessError(
              "cursor-stale",
              "Message baseline was retired",
            );
          }
          const value = {
            raw,
            epoch,
            controller,
            contexts: new Map<string, MessageContext>(),
          };
          this.#baselines.set(id, value);
          this.#boundaries.set(id, boundaryKey(raw.revert));
          return value;
        }).finally(() => {
          opening.settled = true;
          if (this.#opening.get(id) === opening) this.#opening.delete(id);
        }),
      );
      owner = opening;
    }
    owner.users++;
    const selected = owner,
      combined = AbortSignal.any([
        signal,
        selected.controller.signal,
        this.#lifetime.signal,
      ]),
      gate = Promise.withResolvers<Baseline>(),
      abort = () => gate.reject(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) abort();
    void selected.promise.then(gate.resolve, gate.reject);
    try {
      return await gate.promise;
    } finally {
      combined.removeEventListener("abort", abort);
      if (--selected.users === 0 && !selected.settled) {
        if (this.#opening.get(id) === selected) this.#opening.delete(id);
        selected.controller.abort();
      }
    }
  }
  #map(
    raw: NativeMessage,
    id: string,
    context: MessageContext,
    terminal = false,
    fromRecovery = false,
  ): Message | undefined {
    // The retained execution outcome owns failed-idle presentation on both
    // snapshot and live paths. Do not project a second native activity record.
    if (raw.type === "idle" && raw.outcome === "failed") return;
    if (raw.type === "compaction" && raw.status === "running") {
      const current = this.#compactions.get(id);
      if (current?.id === raw.id) {
        // Compaction deltas own source just as assistant streams do. A native
        // unfinished checkpoint cannot erase that prefix or reopen its terminal.
        if (current.status !== "running") raw = current;
        else if (current.summary.startsWith(raw.summary)) {
          raw = { ...raw, summary: current.summary };
        }
      }
    }
    if (raw.type === "assistant") {
      const current = this.#live.get(raw.id);
      if (
        current && millis(current.raw.time.created) > millis(raw.time.created)
      ) {
        const keyed = (
          parts: Extract<NativeMessage, { type: "assistant" }>["content"],
        ) => {
          const ordinals = { text: 0, reasoning: 0 };
          return parts.map((part, index) =>
            [
              part.type === "tool"
                ? `tool:${part.id}`
                : part.type === "text" || part.type === "reasoning"
                ? `${part.type}:${ordinals[part.type]++}`
                : `external:${index}`,
              part,
            ] as const
          );
        };
        raw = {
          ...current.raw,
          content: [
            ...new Map([...keyed(raw.content), ...keyed(current.raw.content)])
              .values(),
          ],
        };
        context = current.context;
      }
    }
    const settled = raw.type === "assistant" &&
      (terminal || context.terminal === true || assistantSettled(raw) ||
        this.#finished.get(id)?.has(raw.id) === true);
    if (raw.type === "assistant" && !settled) {
      const current = this.#live.get(raw.id);
      if (current) {
        raw = {
          ...raw,
          content: raw.content.map((part) => {
            if (part.type !== "tool") return part;
            const retained = current.raw.content.find((p) =>
              p.type === "tool" && p.id === part.id
            );
            if (
              !retained || retained.type !== "tool" ||
              part.state.status === "completed" || part.state.status === "error"
            ) return part;
            if (
              retained.state.status === "completed" ||
              retained.state.status === "error"
            ) return retained;
            return retained.state.status === "running" &&
                part.state.status === "running"
              ? {
                ...part,
                state: { ...part.state, metadata: retained.state.metadata },
              }
              : part;
          }),
        };
      }
    }
    if (raw.type === "assistant") {
      context = this.#assistantContext(
        id,
        raw.id,
        context,
        text(record(raw.metadata).parentID),
      );
    }
    let mapped = mapMessage(
      raw,
      id,
      settled ? { ...context, terminal: true } : context,
    );
    if (!mapped) return;
    mapped = this.#decorateAgent(mapped, id);
    mapped = this.#decorateHelpers(mapped);
    if (raw.type === "shell") {
      let known = this.#projected.get(id);
      if (!known) this.#projected.set(id, known = { shells: new Map() });
      known.shells.set(raw.shellID, raw.id);
      if (raw.status === "running") this.#watchShell(id, raw, context);
    }
    if (raw.type !== "assistant") return mapped;
    if (!settled && !this.#finished.get(id)?.has(raw.id)) {
      this.#live.set(raw.id, {
        session: id,
        raw: structuredClone(raw),
        context,
      });
    }
    if (settled) {
      if (mapped.role === "assistant" && !isAssistantTerminal(mapped)) {
        mapped = { ...mapped, terminal: true };
      }
      this.#live.delete(raw.id);
      let finished = this.#finished.get(id);
      if (!finished) this.#finished.set(id, finished = new Map());
      // This is a replay/restart barrier, never an invented completion clock.
      const at = raw.time.completed == null
        ? finished.get(raw.id)?.at
        : millis(raw.time.completed);
      finished.set(raw.id, {
        start: millis(raw.time.created),
        ...(at === undefined ? {} : { at }),
      });
      this.buffers.removeMessage(raw.id, id);
      if (!fromRecovery) this.recovery.message(raw.id, id);
      return mapped;
    }
    mapped = {
      ...mapped,
      parts: mapped.parts.map((part) => {
        if (part.kind !== "text" && part.kind !== "reasoning") return part;
        const retained = this.buffers.snapshot(part.id, id, raw.id)?.part;
        if (retained) return retained;
        const content = raw.content.filter((p) =>
          p.type === part.kind
        )[Number(part.id.split(":").at(-1))];
        return {
          ...part,
          stream: this.buffers.replacement(
            id,
            content && "text" in content ? content.text.length : 0,
          ),
        };
      }),
    };
    return this.buffers.overlay(mapped);
  }
  page(
    id: string,
    before?: string,
    signal: AbortSignal = new AbortController().signal,
    publish?: (page: MessagePage) => void,
  ): Promise<MessagePage> {
    return this.#own(this.#page(id, before, signal, publish));
  }
  snapshot(
    id: string,
    before?: string,
    signal: AbortSignal = new AbortController().signal,
    scope?: import("@otk/protocol").MessageSnapshotScope,
  ): Promise<MessagePage> {
    if (scope) return this.#own(this.#snapshotIDs(id, scope, signal));
    return this.#own(this.#page(id, before, signal, undefined, true));
  }
  async #snapshotIDs(
    id: string,
    scope: import("@otk/protocol").MessageSnapshotScope,
    signal: AbortSignal,
  ): Promise<MessagePage> {
    ids.decode(id);
    signal.throwIfAborted();
    const owner = await this.#baseline(id, signal);
    const from = this.replay.clock(id),
      revisions = this.replay.revisions(id, scope.messageIDs);
    const items: Message[] = [];
    if (!scope.validate) {
      const facts = await this.#facts({
        sessionID: id,
        messages: scope.messageIDs,
      }, signal);
      for (const messageID of scope.messageIDs) {
        signal.throwIfAborted();
        const retained = await this.requests.get(id, messageID);
        if (retained?.outcome) {
          const order = retained.position && positionOrder(retained.position);
          items.push({
            ...retained.outcome,
            ...(order === undefined ? {} : { sourceOrder: order }),
          });
          continue;
        }
        const raw = await this.reader.get(id, messageID, signal),
          context = facts.contexts[messageID];
        if (!context) {
          throw new HarnessError(
            "capture-stale",
            "Message metadata changed during archive capture",
          );
        }
        const mapped = raw.type === "idle" && raw.outcome === "failed"
          ? (await this.#executionFailureValue(
            id,
            raw.id,
            raw.error,
            millis(raw.time.created),
            context,
            owner.raw.title,
            facts.source.startsWith("sql") ? context.order : undefined,
            signal,
          )).message
          : mapMessage(raw, id, context);
        if (!mapped) {
          throw new HarnessError(
            "capture-stale",
            "A captured record is no longer available",
          );
        }
        items.push({ ...mapped, id: messageID });
      }
    }
    signal.throwIfAborted();
    const session = owner.presentation ??= await revertSession(
      this.options.client(),
      owner.raw,
      signal,
    );
    const clock = this.replay.clock(id);
    if (clock.epoch !== from.epoch) {
      throw new HarnessError("capture-stale", "Archive epoch changed");
    }
    const turns = [
      ...new Set(
        items.map((m) => m.role === "assistant" ? m.replyTo ?? m.id : m.id),
      ),
    ];
    const summaries = this.options.summaries?.(id, turns) ?? {};
    return {
      sessionID: id,
      session: { ...session, revertCommitted: this.revertCommit.latest(id) },
      items,
      from,
      clock,
      revisions: scope.validate
        ? this.replay.revisions(id, scope.messageIDs)
        : revisions,
      version: this.replay.version(id),
      older: null,
      catchup: [],
      helpers: {},
      recovering: [],
      turns: Object.fromEntries(
        turns.map((
          turnID,
        ) => [turnID, {
          boundary: { turnID, complete: true },
          summary: summaries[turnID],
        }]),
      ),
    };
  }
  async #page(
    id: string,
    before?: string,
    signal: AbortSignal = new AbortController().signal,
    publish?: (page: MessagePage) => void,
    snapshot = false,
  ): Promise<MessagePage> {
    ids.decode(id);
    signal.throwIfAborted();
    const token = before === undefined ? undefined : decode(before);
    const revision = this.requests.revision(id);
    let baseline = this.#baselines.get(id);
    if (
      token &&
      (!baseline || !!token.snapshot !== snapshot || token.session !== id ||
        token.epoch !== this.replay.clock(id).epoch ||
        token.cutoff !== (baseline.raw.revert?.messageID ?? null) ||
        (!snapshot && token.source !== baseline.source) ||
        token.revision !== revision)
    ) {
      throw new HarnessError(
        "cursor-stale",
        "Messages changed. Refresh messages before continuing.",
      );
    }
    const capture = this.replay.capture(id);
    if (
      !snapshot && !token && this.#subscriptions.has(id) &&
      !this.#history.has(id)
    ) {
      // The first canonical page is already the repair owner until its boundary
      // settles. Accumulate hints here instead of cancelling it with reconcile.
      this.#history.set(id, {
        pending: true,
        controller: new AbortController(),
        dirty: false,
        targets: new Set(),
      });
    }
    try {
      baseline ??= await this.#baseline(id, signal);
      const owner = baseline;
      signal = AbortSignal.any([
        signal,
        owner.controller.signal,
        this.#lifetime.signal,
      ]);
      const boundary = owner.raw.revert?.messageID,
        cutoff = snapshot ? undefined : boundary,
        compatible =
          (this.#client ?? this.options.client()).service.version === "2.2.6",
        native = token
          ? token.native || undefined
          : (cutoff && compatible ? nativeCursor(cutoff) : undefined);
      const cached = !snapshot && native
        ? this.#cache?.get(this.#key(id, owner, native))
        : undefined;
      if (!snapshot && !cached && native) {
        const key = this.#key(id, owner, native),
          work = this.#prefetch.get(key);
        if (work) {
          this.#prefetch.delete(key);
          work.controller.abort();
        }
      }
      const page = cached?.page ??
        (cutoff && !token && !compatible
          ? await this.reader.before(id, cutoff, signal)
          : await this.reader.page(id, MESSAGE_PAGE_SIZE, native, signal));
      signal.throwIfAborted();
      let facts = cached?.facts;
      // Source order and real-user anchoring are scalar metadata. Native control
      // rows are not fabricated prompts, even when they consume a page slot.
      facts ??= await this.#facts({
        sessionID: id,
        messages: page.items.map((m) => m.id),
        cutoff,
      }, signal);
      if (snapshot) {
        if (token && token.source !== facts.source) {
          throw new HarnessError(
            "cursor-stale",
            "History source changed during archive capture",
          );
        }
      } else this.#acceptFacts(owner, facts);
      // Normalize native failures once for both read-only archives and live
      // materialization. Only the live owner may retain or announce the result.
      const failures = new Map<string, Message>();
      for (const raw of page.items) {
        if (raw.type === "idle" && raw.outcome === "failed") {
          const args = [
            id,
            raw.id,
            raw.error,
            millis(raw.time.created),
            facts.contexts[raw.id],
            owner.raw.title,
            facts.source.startsWith("sql")
              ? facts.contexts[raw.id]?.order
              : undefined,
          ] as const;
          if (!snapshot) await this.#executionFailure(...args, signal);
          const value = await this.#executionFailureValue(...args, signal);
          const order = value.position && positionOrder(value.position);
          failures.set(
            raw.id,
            order === undefined
              ? value.message
              : { ...value.message, sourceOrder: order },
          );
          signal.throwIfAborted();
        }
      }
      let items = page.items.flatMap((raw) => {
        const context = facts!.contexts[raw.id];
        if (!context) {
          throw new HarnessError(
            "capture-stale",
            "Message metadata changed during page capture",
          );
        }
        // Reconnect can discover an in-flight compaction without its start
        // event. A page may seed an absent owner, never replace a live one.
        if (
          !snapshot && raw.type === "compaction" && raw.status === "running" &&
          !this.#compactions.has(id)
        ) this.#compactions.set(id, structuredClone(raw));
        const mapped = failures.get(raw.id) ??
          (snapshot
            ? mapMessage(raw, id, context)
            : this.#map(raw, id, context));
        return mapped ? [mapped] : [];
      }).sort(compareMessages);
      const sequence = facts.source.startsWith("sql");
      const edge = (message: Message) => ({
        created: message.time.created,
        id: message.id,
        ...(sequence ? { order: message.sourceOrder } : {}),
      });
      const compareEdge = (
        message: Message,
        boundary: { created: number; id: string; order?: number },
      ) =>
        (sequence && boundary.order !== undefined &&
            message.sourceOrder !== undefined
          ? message.sourceOrder - boundary.order
          : message.time.created - boundary.created) ||
        (message.id < boundary.id ? -1 : message.id > boundary.id ? 1 : 0);
      let upper = token?.retained;
      if (!token && cutoff) {
        upper = {
          created: facts.metadata.cutoffCreated ??
            millis((await this.reader.get(id, cutoff, signal)).time.created),
          id: cutoff,
          ...(sequence ? { order: facts.cutoffOrder } : {}),
        };
      }
      const lower = page.next && items.length
        ? edge(items.reduce((a, b) => compareEdge(a, edge(b)) < 0 ? a : b))
        : undefined;
      // Each acquisition frontier belongs to its physical index. In particular,
      // interpolation below cannot certify either a native or a clock prefix.
      const sequenced = sequence
        ? await this.requests.page(id, upper, MESSAGE_PAGE_SIZE + 1, "sequence")
        : [];
      const unanchored = sequence
        ? token?.unanchored
          ? { ...token.unanchored, pending: [...token.unanchored.pending] }
          : {
            before: upper && { created: upper.created, id: upper.id },
            pending: [] as string[],
            exhausted: false,
          }
        : undefined;
      let clockRows: Message[] = [];
      if (unanchored) {
        if (unanchored.pending.length) {
          clockRows = await Promise.all(unanchored.pending.map(async (key) => {
            const value = await this.requests.get(
              id,
              key.replace(/^request:/, ""),
            );
            if (!value?.outcome) {
              throw new HarnessError(
                "cursor-stale",
                "Retained message placement changed. Refresh messages.",
              );
            }
            return value.outcome;
          }));
        } else if (!unanchored.exhausted) {
          clockRows = [
            ...await this.requests.page(
              id,
              unanchored.before,
              MESSAGE_PAGE_SIZE,
              "unanchored",
            ),
          ];
          unanchored.exhausted = clockRows.length < MESSAGE_PAGE_SIZE;
          const last = clockRows.at(-1);
          if (last) {
            unanchored.before = { created: last.time.created, id: last.id };
          }
          unanchored.pending = clockRows.map((m) => m.id);
        }
      }
      const retained = sequence
        ? [...sequenced, ...clockRows]
        : await this.requests.page(
          id,
          upper,
          MESSAGE_PAGE_SIZE + 1,
          "timeline",
        );
      if (!snapshot && sequence && facts.cutoffOrder !== undefined) {
        this.requests.cutoff(id, facts.cutoffOrder);
      }
      signal.throwIfAborted();
      const nativeItems = items;
      const normalized = new Map(
        [...failures.values()].map((message) => [message.id, message]),
      );
      const candidates = [...new Map([
        ...items.filter((m) =>
          !token?.reuse || !upper || compareEdge(m, upper) < 0
        ),
        ...retained.filter((m) => !lower || compareEdge(m, lower) >= 0).map(
          (m) => {
            const recovered = normalized.get(m.id);
            if (recovered) m = { ...recovered, sourceOrder: m.sourceOrder };
            if (m.sourceOrder !== undefined) return m;
            // Place plugin-owned records between native sequence positions without
            // treating their clock as a native sequence number.
            const preceding = nativeItems.filter((n) =>
              compareEdge(n, edge(m)) <= 0
            ).at(-1);
            const following = nativeItems.find((n) =>
              compareEdge(n, edge(m)) > 0
            );
            const elapsed = m.time.created -
              (preceding?.time.created ?? m.time.created - 1);
            const remaining = (following?.time.created ?? m.time.created + 1) -
              m.time.created;
            const fraction = (elapsed + 1) / (elapsed + remaining + 2);
            const order = preceding?.sourceOrder ??
              (following?.sourceOrder === undefined
                ? undefined
                : following.sourceOrder - 1);
            return {
              ...m,
              sourceOrder: order === undefined ? undefined : order + fraction,
            };
          },
        ),
      ].map((m) => [m.id, m])).values()].sort((a, b) =>
        compareEdge(a, edge(b))
      );
      const overflow = candidates.length > MESSAGE_PAGE_SIZE;
      const selected = candidates.slice(-MESSAGE_PAGE_SIZE);
      if (unanchored) {
        const consumed = new Set(selected.map((m) => m.id));
        unanchored.pending = unanchored.pending.filter((key) =>
          !consumed.has(key)
        );
      }
      const refill = unanchored && !unanchored.pending.length &&
        !unanchored.exhausted;
      const reuse = overflow || !!refill;
      const proven = new Set([...nativeItems, ...sequenced].map((m) => m.id));
      const consumed = sequence
        ? selected.filter((m) => proven.has(m.id))
        : selected;
      const nextUpper = reuse
        ? consumed.length
          ? edge(consumed.reduce((a, b) => compareEdge(a, edge(b)) < 0 ? a : b))
          : upper
        : lower;
      items = selected.sort(compareMessages);
      const older = reuse || page.next
        ? encode({
          v: 3,
          session: id,
          epoch: owner.epoch,
          cutoff: boundary ?? null,
          native: (reuse ? native : page.next) ?? "",
          source: facts.source,
          revision,
          ...(reuse ? { reuse: true } : {}),
          ...(nextUpper ? { retained: nextUpper } : {}),
          ...(unanchored ? { unanchored } : {}),
          ...(snapshot ? { snapshot: true as const } : {}),
        })
        : null;
      if (snapshot) {
        const session = mapSession(owner.raw);
        signal.throwIfAborted();
        if (
          owner !== this.#baselines.get(id) ||
          owner.epoch !== this.replay.clock(id).epoch ||
          revision !== this.requests.revision(id)
        ) {
          throw new HarnessError(
            "cursor-stale",
            "History baseline was replaced",
          );
        }
        const sealed = capture.seal();
        if (sealed.clock.seq !== capture.from.seq) {
          throw new HarnessError(
            "capture-stale",
            "History changed during archive capture",
          );
        }
        const turnIDs = [
          ...new Set(
            items.filter((m) => m.role === "assistant").map((m) =>
              m.role === "assistant" ? m.replyTo ?? m.id : m.id
            ),
          ),
        ];
        return {
          sessionID: id,
          version: this.replay.version(id),
          from: capture.from,
          clock: sealed.clock,
          session: {
            ...session,
            revertCommitted: this.revertCommit.latest(id),
          },
          items,
          older,
          helpers: {},
          recovering: [],
          catchup: [],
          turns: Object.fromEntries(turnIDs.map((turnID) => [turnID, {
            boundary: facts.metadata.boundaries.find((b) =>
              b.turnID === turnID
            ) ?? { turnID, complete: false },
          }])),
        };
      }
      this.buffers.epoch(id, owner.epoch);
      this.buffers.checkpoint(id, (sid, op) => this.#publish(sid, op));
      items = items.map((m) => this.buffers.overlay(m));
      const covered = new Set(items.map((m) => m.id));
      let notices: import("@otk/protocol").PublicFailure[] | undefined;
      if (!token) {
        const inbox = await this.reader.inbox(id, signal);
        signal.throwIfAborted();
        if (inbox.state === "unsupported") {
          notices = [{
            code: "queued-messages.unsupported",
            retry: "none",
            diagnosticID: inbox.diagnosticID,
            facts: {
              actionLabel: "Loading queued messages",
              target: { sessionID: id, label: owner.raw.title },
              reason: "Queued messages aren't available on this server.",
              origin: "session",
            },
          }];
        }
        const queued = inbox.state === "available" ? inbox.items : [];
        const nextOrder = Math.max(0, ...items.map((m) => m.sourceOrder ?? 0));
        for (
          const message of [
            ...queued.map((row, index) => {
              this.#queue(id, row.id, row.type);
              return inboxMessage(
                row.id,
                row as unknown as Record<string, unknown>,
                millis(row.time.created),
                id,
                { order: nextOrder + index + 1 },
              );
            }),
          ]
        ) {
          covered.add(message.id);
          items = overlay(items, { op: "message.upsert", message });
        }
      }
      signal.throwIfAborted();
      if (
        owner !== this.#baselines.get(id) ||
        owner.epoch !== this.replay.clock(id).epoch ||
        revision !== this.requests.revision(id)
      ) throw new HarnessError("cursor-stale", "Message baseline was replaced");
      // Session notices belong to the baseline, not only its newest page.
      if (!token) owner.notices = notices;
      // A metadata observation can replace raw while previews are in flight.
      // Only cache a presentation derived from the still-current raw snapshot.
      while (!owner.presentation) {
        const raw = owner.raw;
        const presentation = await revertSession(
          this.reader.client(),
          raw,
          signal,
        );
        signal.throwIfAborted();
        if (raw === owner.raw) owner.presentation = presentation;
      }
      signal.throwIfAborted();
      if (
        owner !== this.#baselines.get(id) ||
        owner.epoch !== this.replay.clock(id).epoch ||
        revision !== this.requests.revision(id)
      ) {
        throw new HarnessError(
          "cursor-stale",
          "Retained message placement changed. Refresh messages.",
        );
      }
      const sealed = capture.seal(), recovering = this.recovery.snapshot(id);
      const replacements = new Map<string, number>();
      sealed.events.forEach(({ event }, index) => {
        if (event.op === "part.upsert") {
          replacements.set(`${event.messageID}/${event.part.id}`, index);
        }
        if (event.op === "part.remove") {
          replacements.set(`${event.messageID}/${event.partID}`, index);
        }
      });
      const catchup = sealed.events.filter(({ event }, index) => {
        if (event.op !== "part.blocks") return true;
        if (
          (replacements.get(`${event.messageID}/${event.partID}`) ?? -1) > index
        ) return false;
        recovering.push({
          messageID: event.messageID,
          partID: event.partID,
          generation: event.stream.generation,
        });
        return false;
      }).map((value) => {
        const event = this.#causalEvent(id, value.event);
        return event === value.event ? value : { ...value, event };
      });
      if (this.recovery.scoped(id)) {
        for (const m of items) {
          if (m.role === "assistant" && !isAssistantTerminal(m)) {
            for (const part of m.parts) {
              if (
                (part.kind === "text" || part.kind === "reasoning") &&
                part.stream && !this.buffers.snapshot(part.id, id, m.id)
              ) {
                recovering.push({
                  messageID: m.id,
                  partID: part.id,
                  generation: part.stream.generation,
                });
              }
            }
          }
        }
      }
      for (const { event } of catchup) {
        items = overlay(items, event);
        if (event.op === "message.upsert" && isRealPrompt(event.message)) {
          facts.metadata.prompt = {
            id: event.message.id,
            agent: event.message.agent,
            model: event.message.model,
            variant: event.message.variant,
          };
        }
      }
      items = items.filter((m) => covered.has(m.id)).map((m) =>
        referenced(m, m.id)
      );
      const turnIDs = [
        ...new Set(
          items.flatMap((m) =>
            m.role === "assistant" ? [m.replyTo ?? m.id] : []
          ),
        ),
      ];
      const presentation = owner.presentation;
      const result: MessagePage = {
        sessionID: id,
        version: this.replay.version(id),
        from: capture.from,
        clock: sealed.clock,
        session: {
          ...presentation,
          revertCommitted: this.revertCommit.latest(id),
          ...(owner.notices
            ? {
              notices: owner.notices.map((notice) => ({
                ...notice,
                facts: {
                  ...notice.facts,
                  target: {
                    ...notice.facts?.target,
                    label: presentation.title,
                  },
                },
              })),
            }
            : {}),
        },
        items,
        older,
        prompt: facts.metadata.prompt,
        catchup,
        helpers: {},
        recovering,
        turns: Object.fromEntries(
          turnIDs.map(
            (turnID) => [turnID, {
              boundary: facts!.metadata.boundaries.find((b) =>
                b.turnID === turnID
              ) ?? { turnID, complete: false },
            }],
          ),
        ),
      };
      for (const m of items) {
        for (const p of m.parts) {
          if (p.kind === "tool" && p.call.childSessionID) {
            result.helpers[p.call.childSessionID] = this.#helperSummary(
              p.call.childSessionID,
            );
          }
        }
      }
      owner.prompt = result.prompt;
      publish?.(result);
      if (!cached && this.options.digest && page.items.length) {
        const oldest = page.items.reduce((a, b) =>
          (facts!.contexts[a.id]?.order ?? Infinity) <
              (facts!.contexts[b.id]?.order ?? Infinity)
            ? a
            : b
        );
        const coverage = await this.options.digest.transcriptMetadata(
          id,
          turnIDs,
          signal,
          cutoff,
          { messageID: oldest.id, created: millis(oldest.time.created) },
        );
        signal.throwIfAborted();
        if (owner !== this.#baselines.get(id)) {
          throw new HarnessError(
            "cursor-stale",
            "Message baseline was replaced",
          );
        }
        result.prompt = coverage.prompt ?? result.prompt;
        for (const [turnID, turn] of Object.entries(result.turns)) {
          turn.boundary = coverage.boundaries.find((b) =>
            b.turnID === turnID
          ) ?? turn.boundary;
        }
      }
      const summaries = this.options.summaries?.(id, turnIDs) ?? {};
      for (const [turnID, turn] of Object.entries(result.turns)) {
        turn.summary = summaries[turnID];
      }
      signal.throwIfAborted();
      if (!snapshot && !token) this.#seedHistory(id, page.items.at(-1)?.id);
      this.#next(id, owner, page.next);
      return result;
    } finally {
      capture.release();
    }
  }
  /** Snapshot backfill is staged until the stream's reconnect commit. */
  resync(
    client: V2Client,
    signal: AbortSignal,
  ): () => Promise<void> {
    this.#client = client;
    const starts = [...this.#subscriptions].flatMap((id) => {
      const live = [...this.#live.values()].filter((v) => v.session === id)
        .sort((a, b) => a.context.order - b.context.order);
      return live.length ? [{ id, start: live[0].raw.id }] : [];
    });
    const reader = new Messages(() => client);
    signal.throwIfAborted();
    return async () => {
      signal.throwIfAborted();
      this.invalidate(undefined, true);
      const parentSignal = signal;
      for (const { id, start } of starts) {
        if (!this.#subscriptions.has(id)) continue;
        const controller = new AbortController(),
          signal = AbortSignal.any([
            parentSignal,
            controller.signal,
            this.#lifetime.signal,
          ]);
        this.#backfills.set(id, controller);
        try {
          const rawSession = await client.read(
              (api) =>
                api.session.get({ sessionID: ids.decode(id) }, { signal }),
              signal,
            ),
            cutoff = rawSession.revert?.messageID;
          this.#boundaries.set(id, boundaryKey(rawSession.revert));
          const publishRows = async (rows: NativeMessage[]) => {
            const facts = await this.#facts(
              {
                sessionID: id,
                messages: rows.map((r) => r.id),
                cutoff,
              },
              signal,
              reader,
            );
            signal.throwIfAborted();
            for (const raw of rows) {
              const context = facts.contexts[raw.id];
              if (!context) continue;
              const live = this.#live.get(raw.id);
              if (live) live.context = context;
              const message = this.#map(raw, id, context);
              if (message) this.#publish(id, { op: "message.upsert", message });
            }
          };
          if (client.service.version === "2.2.6") {
            let first: NativeMessage;
            try {
              first = await reader.get(id, start, signal);
            } catch (error) {
              if (error instanceof HarnessError && error.code === "message") {
                this.#publish(id, { op: "stream.reconcile" });
                continue;
              }
              throw error;
            }
            await publishRows([first]);
            let cursor: string | undefined = nativeForwardCursor(start);
            do {
              const page = await reader.forward(id, cursor, signal);
              await publishRows(page.items);
              cursor = page.next;
            } while (cursor);
          } else {
            let cursor: string | undefined;
            do {
              const page = await reader.page(id, SCAN_ROWS, cursor, signal),
                index = page.items.findIndex((r) => r.id === start);
              await publishRows(
                index < 0 ? page.items : page.items.slice(index),
              );
              if (index >= 0) break;
              cursor = page.next;
            } while (cursor);
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          parentSignal.throwIfAborted();
          this.#lifetime.signal.throwIfAborted();
        } finally {
          if (this.#backfills.get(id) === controller) {
            this.#backfills.delete(id);
          }
        }
      }
      signal.throwIfAborted();
      // Epoch rebinding resets the append baseline. Checkpoint full source
      // before buffered or live suffixes can resume in that new generation.
      for (const id of this.#subscriptions) {
        this.buffers.checkpoint(
          id,
          (session, event) => this.#publish(session, event),
        );
      }
    };
  }
  /** Durable delivery order is the native position authority for ephemeral
   * observations: the first durable event of the session aggregate after an
   * observation proves its exact predecessor sequence. */
  async #advance(id: string, seq: number): Promise<void> {
    this.#watermarks.delete(id);
    this.#watermarks.set(id, seq);
    if (this.#watermarks.size > 4096) {
      this.#watermarks.delete(this.#watermarks.keys().next().value!);
    }
    const pending = this.#anchors.get(id);
    if (!pending) return;
    this.#anchors.delete(id);
    const after = seq - 1;
    for (const requestID of pending) {
      const value = await this.requests.get(id, requestID);
      if (!value?.outcome || !value.position) continue;
      const position: RequestPosition = value.position.after === after
        ? { ...value.position, basis: "stream" }
        : { after, rank: this.requests.rank(id, after), basis: "stream" };
      await this.requests.put({ ...value, position });
      this.#announce(id, value.outcome, position);
    }
  }
  /** Submission failures have no native message; reuse plugin-owned retention,
   * page merging and live publication rather than a second session error store. */
  async failure(
    message: Message,
    signal: AbortSignal = this.#lifetime.signal,
  ): Promise<void> {
    const key = message.id.replace(/^request:/, "");
    const previous = await this.requests.get(message.sessionID, key);
    signal.throwIfAborted();
    await this.#observe(
      message.sessionID,
      key,
      message,
      previous,
      undefined,
      signal,
    );
  }
  async submission(
    sessionID: string,
    messageID: string,
    origin: import("@otk/protocol").RequestOrigin = "composer",
  ): Promise<void> {
    await this.requests.observe({
      sessionID,
      id: `submission:${messageID}`,
      request: { origin },
    });
  }
  /** Execution errors can precede any assistant. Their native idle boundary
   * supplies the exact preceding prompt through the existing scalar facts owner. */
  async executionFailure(
    event: V2Event,
    label?: string,
    parent: AbortSignal = this.#lifetime.signal,
  ): Promise<import("@otk/protocol").PublicFailure | undefined> {
    if (
      event.type !== "session.execution.failed" ||
      typeof event.data.sessionID !== "string"
    ) return;
    const signal = AbortSignal.any([parent, this.#lifetime.signal]);
    signal.throwIfAborted();
    const id = ids.encode(event.data.sessionID);
    const nativeID = event.id?.replace(/^evt_/, "msg_");
    let context: MessageContext | undefined;
    let nativeOrder: number | undefined;
    if (event.id) {
      try {
        const facts = await this.#facts(
          { sessionID: id, messages: [nativeID!] },
          signal,
        );
        signal.throwIfAborted();
        context = facts.contexts[nativeID!];
        if (facts.source.startsWith("sql")) nativeOrder = context?.order;
      } catch (error) {
        signal.throwIfAborted();
        this.options.diagnostic(error);
      }
    }
    // Resolve the native turn before the first publication, so the same failure
    // never has a transient standalone and then a turn-attached identity.
    signal.throwIfAborted();
    const message = await this.#executionFailure(
      id,
      nativeID,
      event.data.error,
      event.created ?? Date.now(),
      context,
      label,
      nativeOrder,
      signal,
    );
    const part = message.parts[0];
    return part.kind === "external" ? part.failure : undefined;
  }
  #executionFailure(
    id: string,
    nativeID: string | undefined,
    error: unknown,
    created: number,
    context: MessageContext | undefined,
    label?: string,
    nativeOrder?: number,
    signal = this.#lifetime.signal,
  ): Promise<Message> {
    signal.throwIfAborted();
    const key = `${id}/${nativeID ?? crypto.randomUUID()}`;
    const pending = this.#executionFailures.get(key);
    if (pending) {
      if (!context?.replyTo) return pending;
      return pending.then(() => {
        signal.throwIfAborted();
        return this.#executionFailure(
          id,
          nativeID,
          error,
          created,
          context,
          label,
          nativeOrder,
          signal,
        );
      });
    }
    const work = this.#materializeExecutionFailure(
      id,
      nativeID,
      error,
      created,
      context,
      label,
      nativeOrder,
      signal,
    )
      .finally(() => this.#executionFailures.delete(key));
    this.#executionFailures.set(key, work);
    return work;
  }
  async #materializeExecutionFailure(
    id: string,
    nativeID: string | undefined,
    error: unknown,
    created: number,
    context: MessageContext | undefined,
    label?: string,
    nativeOrder?: number,
    signal = this.#lifetime.signal,
  ): Promise<Message> {
    const value = await this.#executionFailureValue(
      id,
      nativeID,
      error,
      created,
      context,
      label,
      nativeOrder,
      signal,
    );
    if (value.message !== value.previous?.outcome) {
      await this.#observe(
        id,
        value.key,
        value.message,
        value.previous,
        value.position,
        signal,
      );
      if (value.previous?.outcome) {
        const part = value.message.parts.find((part) =>
          part.kind === "external" && part.failure
        );
        if (part?.kind === "external" && part.failure) {
          this.options.recoveredFailure?.(id, part.failure);
        }
      }
    }
    return value.message;
  }
  /** Construction may read existing identity/position, but never acquires live
   * publication, retention, watermarks or a sequence probe for an archive. */
  async #executionFailureValue(
    id: string,
    nativeID: string | undefined,
    error: unknown,
    created: number,
    context: MessageContext | undefined,
    label?: string,
    nativeOrder?: number,
    signal = this.#lifetime.signal,
  ) {
    signal.throwIfAborted();
    const diagnosticID = nativeID
      ? `execution:${nativeID.replace(/^msg_/, "evt_")}`
      : crypto.randomUUID();
    const key = `failure:${diagnosticID}`;
    const previous = await this.requests.get(id, key);
    signal.throwIfAborted();
    const parent =
      previous?.outcome?.role === "context" && previous.outcome.replyTo ||
      context?.replyTo;
    const submission = parent
      ? await this.requests.get(id, `submission:${parent}`)
      : undefined;
    signal.throwIfAborted();
    const origin = submission?.request?.origin as
      | import("@otk/protocol").RequestOrigin
      | undefined;
    if (previous?.outcome) {
      const known = previous.outcome;
      const missingOrigin = origin &&
        known.parts.some((part) =>
          part.kind === "external" &&
          part.failure?.diagnosticID === diagnosticID &&
          !part.failure.facts?.origin
        );
      const missingParent = known.role === "context" && !known.replyTo &&
        context?.replyTo;
      const message = missingOrigin || missingParent ||
          known.role === "context" && !known.outcomeTime
        ? {
          ...known,
          ...(known.role === "context" && !known.outcomeTime
            ? { outcomeTime: outcomeTime({ error: known.time.created }) }
            : {}),
          ...(missingParent ? { replyTo: missingParent } : {}),
          parts: missingOrigin
            ? known.parts.map((part) =>
              part.kind === "external" &&
                part.failure?.diagnosticID === diagnosticID &&
                !part.failure.facts?.origin
                ? {
                  ...part,
                  failure: {
                    ...part.failure,
                    facts: { ...part.failure.facts, origin },
                  },
                }
                : part
            )
            : known.parts,
        }
        : known;
      return {
        key,
        previous,
        message,
        position: previous.position,
      };
    }
    const message = requestFailureRecord(
      id,
      {
        code: "native.execution",
        retry: "none",
        diagnosticID,
        facts: {
          ...this.reader.client().failureFacts(error),
          actionLabel: "Running session",
          ...(origin ? { origin } : {}),
          target: { sessionID: id, label },
          outcome: "rejected",
        },
      },
      created,
      context?.replyTo,
    );
    const after = nativeOrder === undefined ? undefined : nativeOrder - 1;
    return {
      key,
      previous,
      message,
      position: after === undefined ? undefined : {
        after,
        rank: this.requests.rank(id, after),
        basis: "stream" as const,
      },
    };
  }
  async #observe(
    id: string,
    requestID: string,
    outcome: Message,
    previous: import("./request-retention.ts").RetainedRequest | undefined,
    nativePosition?: RequestPosition,
    signal = this.#lifetime.signal,
  ): Promise<void> {
    signal.throwIfAborted();
    const value = { ...previous, id: requestID, sessionID: id, outcome };
    const settled = previous?.outcome && previous.position &&
      previous.position.basis !== "pending";
    const known = this.#watermarks.get(id);
    if (settled || nativePosition || known !== undefined) {
      // A redelivered settlement keeps its first proven position.
      const position = settled ? previous.position! : nativePosition ?? {
        after: known!,
        rank: this.requests.rank(id, known!),
        basis: "stream" as const,
      };
      await this.requests.put({ ...value, position });
      signal.throwIfAborted();
      this.#announce(id, outcome, position);
      return;
    }
    // Retained before any probe, so an interrupted resolution keeps the record.
    await this.requests.put({
      ...value,
      position: { after: null, rank: 0, basis: "pending" },
    });
    let seq: number | undefined;
    try {
      seq = await this.#sequence(id, undefined, signal);
    } catch (error) {
      signal.throwIfAborted();
      this.options.diagnostic(error);
    }
    signal.throwIfAborted();
    const position: RequestPosition = seq === undefined
      ? { after: null, rank: 0, basis: "clock" }
      : { after: seq, rank: this.requests.rank(id, seq), basis: "lookup" };
    await this.requests.put({ ...value, position });
    signal.throwIfAborted();
    const pending = this.#anchors.get(id) ?? [];
    this.#anchors.set(id, [...pending, requestID]);
    this.#announce(id, outcome, position);
  }
  /** Native revert authority: observations after a committed boundary are
   * discarded with the native messages and inbox rows at or after it. */
  async #revertObservations(
    id: string,
    type: string,
    messageID: string | undefined,
  ): Promise<void> {
    if (type === "session.revert.cleared") this.requests.cutoff(id, null);
    if (type === "session.revert.staged" && messageID) {
      let seq: number | undefined;
      try {
        seq = await this.#sequence(id, messageID);
      } catch (error) {
        this.#lifetime.signal.throwIfAborted();
        this.options.diagnostic(error);
      }
      this.#lifetime.signal.throwIfAborted();
      this.requests.cutoff(id, seq ?? null);
    }
    if (type === "session.revert.committed") {
      const from = this.requests.cutoff(id);
      if (from !== undefined) await this.requests.retire(id, from);
      this.requests.cutoff(id, null);
    }
  }
  #confirmRevert(id: string, event: V2Event): void {
    const boundaryID = text(event.data.to), at = event.created;
    if (!boundaryID || at === undefined) return;
    const latest = this.revertCommit.latest(id);
    if (
      latest && (at < latest.at ||
        (at === latest.at && boundaryID === latest.boundaryID))
    ) return;
    const fact = { boundaryID, at };
    this.#revertCommits.set(id, fact);
    this.#publish(id, { op: "session.revert.committed", ...fact });
  }
  async #sequence(
    id: string,
    messageID?: string,
    signal = this.#lifetime.signal,
  ): Promise<number | undefined> {
    signal.throwIfAborted();
    const input = { sessionID: id, ...(messageID ? { messageID } : {}) };
    if (this.options.sequence) {
      return await this.options.sequence(input, signal);
    }
    if (!this.options.digest) return;
    return (await this.options.digest.read("opcv2.request.anchor", input, {
      owner: `v2-request-anchor:${id}`,
      priority: "attention",
      signal,
    })).seq;
  }
  #announce(id: string, outcome: Message, position: RequestPosition): void {
    if (!this.#subscriptions.has(id) || this.#lifetime.signal.aborted) return;
    const baseline = this.#baselines.get(id);
    // API pages order by native clocks; their live counters are page-local.
    const order = baseline?.source?.startsWith("api")
      ? (baseline.order ?? 0) + 0.5
      : positionOrder(position);
    this.#publish(id, {
      op: "message.upsert",
      message: order === undefined
        ? outcome
        : { ...outcome, sourceOrder: order },
    });
  }
  async deleted(id: string): Promise<void> {
    this.#revertCommits.delete(id);
    this.#anchors.delete(id);
    this.#watermarks.delete(id);
    await this.requests.remove(id);
    this.release(id);
  }
  #emitShell(
    id: string,
    nativeID: string,
    event: V2Event,
    context: MessageContext,
    found?: Extract<NativeMessage, { type: "shell" }>,
  ): void {
    const shell = record(event.data.shell),
      previous = this.#shells.get(String(shell.id));
    if (event.type.endsWith("ended")) {
      previous?.controller.abort();
      this.#shells.delete(String(shell.id));
    }
    let raw = found ?? {
      id: nativeID,
      type: "shell",
      shellID: shell.id,
      command: shell.command,
      status: shell.status,
      metadata: previous?.raw.metadata ??
        (record(shell.metadata).background === true
          ? { ...event.metadata, background: true }
          : event.metadata),
      time: {
        created:
          (previous?.raw.time.created ?? millis(record(shell.time).started)) ||
          event.created || Date.now(),
        ...(event.type.endsWith("ended")
          ? { completed: event.created ?? Date.now() }
          : {}),
      },
      ...(event.data.output ? { output: event.data.output } : {}),
      exit: shell.exit,
    } as Extract<NativeMessage, { type: "shell" }>;
    if (
      found && event.type.endsWith("ended") &&
      found.time.completed === undefined
    ) {
      raw = {
        ...found,
        status: shell.status as typeof found.status,
        time: { ...found.time, completed: event.created ?? Date.now() },
        ...(event.data.output
          ? { output: event.data.output as typeof found.output }
          : {}),
        ...(typeof shell.exit === "number" ? { exit: shell.exit } : {}),
      };
    }
    const message = this.#map(raw, id, context);
    if (message) this.#publish(id, { op: "message.upsert", message });
    this.changed(id);
  }
  #findShell(id: string, shellID: string, event: V2Event): void {
    const key = `${id}/${shellID}`, previous = this.#shellLookups.get(key);
    if (previous) {
      previous.event = event;
      return;
    }
    const controller = new AbortController(),
      work = { session: id, event, controller };
    this.#shellLookups.set(key, work);
    const signal = AbortSignal.any([
      controller.signal,
      this.#lifetime.signal,
      this.reader.client().signal,
    ]);
    void this.#own(
      (async () => {
        let cursor: string | undefined;
        do {
          const page = await this.reader.page(
            id,
            SCAN_ROWS,
            cursor,
            signal,
            "shell",
          );
          signal.throwIfAborted();
          const raw = page.items.find((
            m,
          ): m is Extract<NativeMessage, { type: "shell" }> =>
            m.type === "shell" && m.shellID === shellID
          );
          if (raw) {
            const facts = await this.#facts({
              sessionID: id,
              messages: [raw.id],
            }, signal);
            signal.throwIfAborted();
            const context = facts.contexts[raw.id];
            if (!context) {
              this.#repairHistory(id);
              return;
            }
            this.#emitShell(id, raw.id, work.event, context, raw);
            return;
          }
          cursor = page.next;
          // A shell lookup releases every bounded page and yields between chunks.
          if (cursor) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        } while (cursor);
        this.#repairHistory(id);
      })().catch((error) => {
        if (!signal.aborted) {
          this.options.diagnostic(error);
          this.#repairHistory(id);
        }
      }).finally(() => {
        if (this.#shellLookups.get(key) === work) {
          this.#shellLookups.delete(key);
        }
      }),
    );
  }
  async event(event: V2Event): Promise<void> {
    try {
      await this.#event(event);
    } catch (error) {
      const sid = text(event.data.sessionID);
      if (sid && sid !== "global") this.#repairHistory(ids.encode(sid));
      throw error;
    }
  }
  async #event(event: V2Event): Promise<void> {
    if (event.type === "agent.updated" || event.type === "config.updated") {
      this.colors?.reset(event.location?.directory);
    }
    const d = event.data,
      sid = text(d.sessionID) ?? text(record(d.form).sessionID);
    if (!sid || sid === "global") return;
    const id = ids.encode(sid);
    const covered = this.#history.get(id)?.head?.seq;
    if (
      covered !== undefined && event.durable?.aggregateID === sid &&
      event.durable.seq <= covered && knownSessionEvent(event.type)
    ) {
      // A canonical native checkpoint already contains this durable fact.
      // Delayed stream starts must not regress a repaired terminal record.
      // A body checkpoint does not carry the native revert commit's cause.
      if (event.type === "session.revert.committed") {
        this.#confirmRevert(id, event);
      }
      return;
    }
    if (
      event.durable && event.durable.aggregateID === sid &&
      Number.isSafeInteger(event.durable.seq)
    ) await this.#advance(id, event.durable.seq);
    if (/^(permission\.|form\.)/.test(event.type)) {
      // Already-delivered native facts are retained even without a viewer. This
      // never reads unviewed bodies or performs a population inventory scan.
      const request = event.type === "form.created" ? record(d.form) : d,
        requestID = text(d.requestID) ?? text(request.id);
      if (!requestID) return;
      const previous = await this.requests.get(id, requestID);
      this.#lifetime.signal.throwIfAborted();
      if (event.type === "permission.asked" || event.type === "form.created") {
        await this.requests.observe({ id: requestID, sessionID: id, request });
      } else if (
        ["permission.replied", "form.replied", "form.cancelled"].includes(
          event.type,
        )
      ) {
        await this.#observe(
          id,
          requestID,
          requestOutcome(event, id, requestID, previous?.request),
          previous,
        );
      }
      return;
    }
    if (/^session\.(tool\.|execution\.)/.test(event.type)) {
      this.#requestHelper(id, true);
    }
    if (event.type === "session.retry.scheduled" && event.id) {
      const outcome = lifecycleRecord(event, id);
      await this.#observe(
        id,
        outcome.id,
        outcome,
        await this.requests.get(id, outcome.id),
      );
      const live = this.#live.get(text(d.assistantMessageID) ?? "");
      if (live) {
        live.raw.retry = {
          attempt: Number(d.attempt),
          at: millis(d.at),
          error: d.error,
        } as typeof live.raw.retry;
        const mapped = mapMessage(live.raw, id, live.context);
        const part = mapped.parts.find((p) => p.id === `${live.raw.id}:retry`);
        if (part) {
          this.#publish(id, {
            op: "part.upsert",
            messageID: live.raw.id,
            part,
          });
        }
      }
      this.changed(id);
      return;
    }
    if (
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    ) {
      this.#clearRetry(id);
    }
    if (
      event.type.startsWith("session.") &&
      !event.type.startsWith("session.execution.")
    ) this.changed(id);
    if (/^session\.revert\./.test(event.type)) {
      const revert = event.type === "session.revert.staged"
        ? d.revert
        : undefined;
      await this.#revertObservations(
        id,
        event.type,
        text(record(revert).messageID),
      );
      if (event.type === "session.revert.committed") {
        this.#confirmRevert(id, event);
      }
      this.#boundary(
        id,
        revert,
        event.type === "session.revert.committed" && !this.#boundaries.has(id),
      );
      return;
    }
    if (event.type === "session.deleted") {
      await this.deleted(id);
      return;
    }
    if (event.type === "session.message.content.updated") {
      this.#repairHistory(id, text(d.messageID));
      return;
    }
    // Retain delivered future records even without a viewer; known native-only
    // metadata/control families remain outside transcript placement (plan 8.17).
    if (
      event.id && event.type.startsWith("session.") &&
      !knownSessionEvent(event.type)
    ) {
      const outcome = lifecycleRecord(event, id);
      await this.#observe(
        id,
        outcome.id,
        outcome,
        await this.requests.get(id, outcome.id),
      );
      this.#repairHistory(id, text(d.messageID) ?? text(d.assistantMessageID));
      return;
    }
    const retained = typeof d.assistantMessageID === "string" &&
      this.#live.get(d.assistantMessageID)?.session === id;
    if (
      !this.#subscriptions.has(id) &&
      !/^session\.(text|reasoning)\./.test(event.type) && !(retained &&
        /^session\.(text\.|reasoning\.|step\.(streamed|ended|failed)$)/.test(
          event.type,
        ))
    ) {
      if (
        typeof d.assistantMessageID === "string" &&
        /^session\.step\.(ended|failed)$/.test(event.type)
      ) this.buffers.complete(d.assistantMessageID, () => {});
      return;
    }
    const sourceID = event.id?.replace(/^evt_/, "msg_");
    const contextFor = (
      messageID: string,
      admitted = false,
    ): MessageContext => {
      const baseline = this.#baselines.get(id);
      const existing = baseline?.contexts.get(messageID);
      if (existing && !admitted) return existing;
      const context = {
        order: baseline?.source?.startsWith("api")
          ? (baseline.order ?? 0) + 1
          : event.durable?.seq ?? ++this.#revisions,
        replyTo: baseline?.prompt?.id,
      };
      this.#context(baseline, messageID, context);
      return context;
    };
    if (
      event.type === "session.inbox.cancelled" && typeof d.inboxID === "string"
    ) {
      this.#queued.get(id)?.delete(d.inboxID);
      this.#publish(id, { op: "message.remove", messageID: d.inboxID });
      this.changed(id);
      return;
    }
    if (
      event.type === "session.inbox.enqueued" && typeof d.inboxID === "string"
    ) {
      this.#queue(id, d.inboxID, record(d.item).type);
      this.#publish(id, {
        op: "message.upsert",
        message: inboxMessage(
          d.inboxID,
          record(d.item),
          event.created ?? Date.now(),
          id,
          contextFor(d.inboxID),
        ),
      });
      return;
    }
    if (
      sourceID &&
      (event.type === "session.synthetic" ||
        event.type === "session.instructions.updated" ||
        event.type === "session.skill.activated")
    ) {
      const raw = eventMessage(event);
      if (!raw) {
        this.#repairHistory(id);
        return;
      }
      this.#publish(id, {
        op: "message.upsert",
        message: mapMessage(raw, id, contextFor(raw.id))!,
      });
      this.changed(id);
      return;
    }
    if (
      event.type === "session.shell.started" ||
      event.type === "session.shell.ended"
    ) {
      const shell = record(d.shell);
      if (typeof shell.id !== "string" || typeof shell.command !== "string") {
        this.#repairHistory(id);
        return;
      }
      const nativeID = this.#projected.get(id)?.shells.get(shell.id) ??
        (event.type.endsWith("started") ? sourceID : undefined);
      if (!nativeID) {
        this.#findShell(id, shell.id, event);
        return;
      }
      this.#emitShell(id, nativeID, event, contextFor(nativeID));
      return;
    }
    if (event.type.startsWith("session.compaction.") && sourceID) {
      const known = this.#compactions.get(id),
        nativeID = text(d.inputID) ??
          (event.type.endsWith("started")
            ? sourceID
            : known?.status === "running" || event.type.endsWith("failed")
            ? known?.id ?? sourceID
            : sourceID);
      const status = event.type.endsWith("started")
        ? "running"
        : event.type.endsWith("failed")
        ? "failed"
        : "completed";
      if (event.type.endsWith("delta")) {
        if (known?.status === "running") {
          const raw = {
            ...known,
            summary: known.summary + (text(d.text) ?? ""),
          };
          this.#compactions.set(id, raw);
          this.#publish(id, {
            op: "message.upsert",
            message: this.#map(raw, id, contextFor(nativeID))!,
          });
        } else this.#repairHistory(id);
        return;
      }
      // Mirror the native message-updater's lifecycle shapes, including absent
      // metadata. A terminal record replaces streamed state; it cannot retain
      // fields the native terminal schema dropped or invent an empty object.
      const previous = known?.id === nativeID ? known : undefined;
      const raw = {
        id: nativeID,
        type: "compaction",
        status,
        reason: d.reason ?? "manual",
        ...(status === "failed" ? { error: d.error } : {
          summary: status === "running" ? "" : text(d.text) ?? "",
          ...(d.model ? { model: d.model } : {}),
          ...(d.native ? { native: d.native } : {}),
        }),
        ...(d.cost !== undefined ? { cost: d.cost } : {}),
        ...(d.tokens ? { tokens: d.tokens } : {}),
        metadata: status === "running"
          ? event.metadata
          : status === "failed"
          ? previous?.metadata ?? event.metadata
          : event.metadata
          ? { ...previous?.metadata, ...event.metadata }
          : previous?.metadata,
        time: previous?.time ?? { created: event.created ?? Date.now() },
      } as Extract<NativeMessage, { type: "compaction" }>;
      this.#compactions.set(id, structuredClone(raw));
      const message = this.#map(
        raw,
        id,
        contextFor(nativeID, status === "running" && known?.id !== nativeID),
      );
      if (message) this.#publish(id, { op: "message.upsert", message });
      this.changed(id);
      return;
    }
    if (
      event.type === "session.agent.selected" ||
      event.type === "session.model.selected"
    ) {
      const baseline = this.#baselines.get(id);
      const raw = eventMessage(event, baseline?.raw);
      if (raw) {
        this.#publish(id, {
          op: "message.upsert",
          message: this.#map(raw, id, contextFor(raw.id))!,
        });
      }
      if (baseline) {
        if (event.type === "session.agent.selected") {
          baseline.raw.agent = d.agent as string;
        } else baseline.raw.model = d.model as NativeSession["model"];
      }
      if (baseline?.prompt) {
        if (
          event.type === "session.agent.selected" && typeof d.agent === "string"
        ) baseline.prompt.agent = d.agent;
        if (event.type === "session.model.selected") {
          const model = record(d.model);
          if (
            typeof model.id === "string" && typeof model.providerID === "string"
          ) {
            baseline.prompt.model = {
              provider: model.providerID,
              model: model.id,
            };
            baseline.prompt.variant = text(model.variant);
          }
        }
      }
      const selection: import("@otk/protocol").PromptSelection = {};
      if (
        event.type === "session.agent.selected" && typeof d.agent === "string"
      ) selection.agent = d.agent;
      if (event.type === "session.model.selected") {
        const model = record(d.model);
        if (
          typeof model.id === "string" && typeof model.providerID === "string"
        ) {
          selection.model = { provider: model.providerID, model: model.id };
          selection.variant = text(model.variant);
        }
      }
      this.#publish(id, { op: "session.selection", selection });
      this.changed(id);
      return;
    }
    if (event.type === "session.moved") {
      const baseline = this.#baselines.get(id);
      let raw = eventMessage(event, baseline?.raw);
      // The durable record owns `previous`: native derives it from its own
      // projection, which the session view does not reproduce exactly (an
      // empty subpath). The event-derived record stands in only while absent.
      if (raw) {
        try {
          raw = await this.reader.get(id, raw.id, this.#lifetime.signal);
        } catch (error) {
          this.#lifetime.signal.throwIfAborted();
          if (errorTag(error) !== "MessageNotFoundError") throw error;
        }
      }
      if (raw) {
        this.#publish(id, {
          op: "message.upsert",
          message: this.#map(raw, id, contextFor(raw.id))!,
        });
      }
      if (baseline) {
        baseline.raw.location = d.location as NativeSession["location"];
        baseline.raw.projectID = d.projectID as NativeSession["projectID"];
        baseline.raw.subpath = d.subpath as NativeSession["subpath"];
      }
      return;
    }
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      const raw = eventMessage(event);
      if (raw) {
        const message = this.#map(raw, id, contextFor(raw.id));
        if (message) this.#publish(id, { op: "message.upsert", message });
      }
      this.recovery.terminal(id);
      return;
    }
    const messageID = text(d.assistantMessageID);
    const finished = messageID
      ? this.#finished.get(id)?.get(messageID)
      : undefined;
    if (finished !== undefined) {
      const started = typeof d.started === "number" ? d.started : event.created;
      const clock = finished.at === undefined
        ? started
        : event.created ?? started;
      const boundary = finished.at ?? finished.start;
      if (
        event.type === "session.step.started" &&
        (boundary === undefined || clock !== undefined && clock > boundary)
      ) this.#finished.get(id)!.delete(messageID!);
      else return;
    }
    const currentAttempt = messageID ? this.#live.get(messageID) : undefined;
    if (
      currentAttempt && event.created !== undefined &&
      event.created < millis(currentAttempt.raw.time.created)
    ) return;
    if (event.type === "session.step.started" && messageID) {
      const existing = this.#live.get(messageID);
      const restart = finished !== undefined;
      if (restart) this.recovery.restart(id, messageID);
      const model = record(d.model);
      if (
        typeof model.id !== "string" || typeof model.providerID !== "string" ||
        typeof d.agent !== "string"
      ) {
        this.#repairHistory(id, messageID);
        return;
      }
      this.#clearRetry(id, messageID);
      const raw: Extract<NativeMessage, { type: "assistant" }> = {
        id: messageID,
        type: "assistant",
        agent: d.agent,
        model: {
          id: model.id,
          providerID: model.providerID,
          ...(typeof model.variant === "string"
            ? { variant: model.variant }
            : {}),
        },
        metadata: event.metadata,
        ...(d.snapshot ? { snapshot: { start: d.snapshot as string } } : {}),
        content: existing?.raw.content ?? [],
        time: {
          created: typeof d.started === "number"
            ? d.started
            : event.created ?? Date.now(),
        },
      };
      const baseline = this.#baselines.get(id),
        context = {
          ...this.#assistantContext(
            id,
            messageID,
            existing?.context ?? baseline?.contexts.get(messageID) ?? {
              order: baseline?.source?.startsWith("api")
                ? (baseline.order ?? 0) + 1
                : event.durable?.seq ?? ++this.#revisions,
            },
            text(d.parentID) ??
              text(
                record("metadata" in event ? event.metadata : undefined)
                  .parentID,
              ),
            true,
          ),
          terminal: undefined,
        };
      this.#context(baseline, messageID, context);
      this.#live.set(messageID, { session: id, raw, context });
      this.buffers.beginReply(id, messageID);
      this.#publish(id, {
        op: "message.upsert",
        message: restart
          ? { ...mapMessage(raw, id, context)!, parts: [] }
          : mapMessage(raw, id, context)!,
        ...(restart ? { restart: true } : {}),
      });
      this.changed(id);
      return;
    }
    if (messageID) {
      const live = this.#live.get(messageID);
      if (
        event.type === "session.step.streamed" && live &&
        event.created !== undefined
      ) {
        // This is the native persisted output edge. The later terminal event
        // includes bookkeeping/tool settlement and must not replace that clock.
        live.raw.time.streamed = event.created;
        const header = mapMessage(live.raw, id, live.context)!;
        header.parts = [];
        this.#publish(id, { op: "message.upsert", message: header });
        return;
      }
      if (/^session\.(text|reasoning)\./.test(event.type)) {
        // Native deltas are not persisted until block end. The existing stream
        // owner retains unfinished source before its first viewer, without reads
        // or publication; a later native page overlays that same authority.
        const acquired = this.#subscriptions.has(id) || !!live;
        const kind = event.type.includes(".reasoning.") ? "reasoning" : "text",
          ordinal = d.ordinal;
        if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0) return;
        const pid = partID(messageID, kind, Number(ordinal));
        const previous = this.buffers.snapshot(pid, id, messageID)?.part;
        const shell: Extract<
          import("@otk/protocol").Part,
          { kind: "text" | "reasoning" }
        > = kind === "text"
          ? { kind: "text" as const, id: pid, synthetic: false, blocks: [] }
          : {
            kind: "reasoning" as const,
            id: pid,
            blocks: [],
            time: {
              start: previous?.kind === "reasoning"
                ? previous.time.start
                : event.type.endsWith(".started")
                ? (event.created ?? Date.now())
                : (millis(live?.raw.time.created) || event.created ||
                  Date.now()),
              ...(event.type.endsWith(".ended")
                ? { end: event.created ?? Date.now() }
                : {}),
            },
          };
        if (event.type.endsWith(".delta")) {
          if (
            typeof d.delta === "string" &&
            !this.buffers.append(
              pid,
              d.delta,
              (session, op) => this.#publish(session, op),
            )
          ) {
            if (acquired) this.recovery.touch(id, messageID, pid);
          }
          return;
        }
        if (event.type.endsWith(".started")) {
          // A native page can expose the empty block before its start event is
          // dispatched. Only an event-owned append source consumes that start;
          // an HTTP checkpoint is replacement authority, never an append seed.
          if (previous) return;
          if (
            !live?.raw.content.filter((p) => p.type === kind)[Number(ordinal)]
          ) {
            live?.raw.content.push(
              kind === "text" ? { type: "text", text: "" } : {
                type: "reasoning",
                text: "",
                ...(d.native === undefined ? {} : {
                  native: record(d.native) as NonNullable<
                    NativeMessage["metadata"]
                  >,
                }),
                time: { created: event.created ?? Date.now() },
              },
            );
          }
          this.buffers.upsert(id, messageID, shell, "");
          if (acquired) {
            this.#publish(id, {
              op: "part.upsert",
              messageID,
              part: this.buffers.snapshot(pid)!.part,
            });
            this.recovery.part(messageID, pid, id);
          }
          return;
        }
        if (event.type.endsWith(".ended") && typeof d.text === "string") {
          if (!acquired) {
            this.buffers.remove(pid);
            return;
          }
          const nativePart = live?.raw.content.filter((p) =>
            p.type === kind
          )[Number(ordinal)];
          if (nativePart?.type === "text" || nativePart?.type === "reasoning") {
            nativePart.text = d.text;
            if (d.native !== undefined) {
              nativePart.native = record(d.native) as NonNullable<
                NativeMessage["metadata"]
              >;
            }
            if (nativePart.type === "reasoning") {
              nativePart.time = {
                created: nativePart.time?.created ??
                  (shell.kind === "reasoning"
                    ? shell.time.start
                    : event.created ?? Date.now()),
                completed: event.created ?? Date.now(),
              };
            }
          }
          shell.source = nativeSource(
            kind,
            nativePart ??
              {
                type: kind,
                text: d.text,
                ...(d.native === undefined ? {} : { native: d.native }),
              },
            d.text,
          );
          const finished =
            this.buffers.finishPart(id, messageID, shell, d.text) ??
              { ...shell, blocks: importMarkdown(d.text) };
          if (acquired) {
            this.#publish(id, {
              op: "part.upsert",
              messageID,
              part: finished,
              lastOutput: event.created,
            });
            this.recovery.part(messageID, pid, id);
          }
          return;
        }
      }
      if (
        event.type === "session.step.ended" ||
        event.type === "session.step.failed"
      ) {
        this.#clearRetry(id, messageID);
        if (!live) {
          let finished = this.#finished.get(id);
          if (!finished) this.#finished.set(id, finished = new Map());
          finished.set(
            messageID,
            event.created === undefined ? {} : { at: event.created },
          );
          this.recovery.touch(id, messageID, `${messageID}:finish`);
          this.recovery.terminal(id, messageID);
          return;
        }
        const raw = {
          ...live.raw,
          ...(d.cost !== undefined ? { cost: d.cost } : {}),
          ...(d.tokens !== undefined ? { tokens: d.tokens } : {}),
          ...(d.error ? { error: d.error } : {}),
          finish: d.finish ??
            (event.type.endsWith("failed") ? "error" : undefined),
          rawFinish: d.rawFinish,
          native: d.native,
          ...(d.snapshot || d.files
            ? {
              snapshot: {
                ...live.raw.snapshot,
                ...(d.snapshot ? { end: d.snapshot } : {}),
                ...(d.files ? { files: d.files } : {}),
              },
            }
            : {}),
          time: {
            ...live.raw.time,
            ...(event.created === undefined
              ? {}
              : { completed: event.created }),
          },
        } as typeof live.raw;
        this.buffers.complete(
          messageID,
          (session, op) => this.#publish(session, op),
        );
        const header = mapMessage(raw, id, live.context)!;
        if (header.role === "assistant" && event.created === undefined) {
          header.terminal = true;
        }
        const boundaries = header.parts.filter((p) =>
          p.kind === "external" && p.activity?.layout === "boundary"
        );
        header.parts = [];
        this.#publish(id, { op: "message.upsert", message: header });
        for (const part of boundaries) {
          this.#publish(id, { op: "part.upsert", messageID, part });
        }
        this.#publish(id, {
          op: "part.upsert",
          messageID,
          part: {
            kind: "step",
            id: `${messageID}:finish`,
            phase: "finish",
            source: nativeSource("assistant", raw),
            ...(typeof d.cost === "number" ? { cost: d.cost } : {}),
            ...(completeTokens(d.tokens)
              ? { tokens: completeTokens(d.tokens) }
              : {}),
          },
        });
        this.recovery.terminal(id, messageID);
        this.#live.delete(messageID);
        let finished = this.#finished.get(id);
        if (!finished) this.#finished.set(id, finished = new Map());
        finished.set(messageID, {
          start: millis(live.raw.time.created),
          ...(event.created === undefined ? {} : { at: event.created }),
        });
        this.changed(id);
        return;
      }
      if (/^session\.tool\./.test(event.type)) {
        if (!live) {
          this.recovery.touch(
            id,
            messageID,
            partID(messageID, "tool", text(d.id) ?? ""),
          );
          return;
        }
        this.#tool(event, live);
        return;
      }
    }
    // Non-step projected messages are checkpointed once at their durable edge.
    if (event.type === "session.inbox.delivered") {
      this.changed(id);
      const nativeID = text(d.inboxID);
      const kind = nativeID ? this.#queued.get(id)?.get(nativeID) : undefined;
      if (nativeID) this.#queued.get(id)?.delete(nativeID);
      // Native materializes a message under the inbox ID only for prompt
      // items. A compaction start reuses the ID as its input; a move's record
      // comes from its own session.moved event, so its queued item retires.
      if (!nativeID || kind === "compaction") return;
      if (kind === "move") {
        this.#publish(id, { op: "message.remove", messageID: nativeID });
        return;
      }
      let raw: NativeMessage;
      try {
        raw = await this.reader.get(id, nativeID, this.#lifetime.signal);
      } catch (error) {
        this.#lifetime.signal.throwIfAborted();
        // An unobserved queued item: absence proves only that delivery
        // made no native message. Transport and other failures propagate.
        if (errorTag(error) !== "MessageNotFoundError") throw error;
        this.#publish(id, { op: "message.remove", messageID: nativeID });
        return;
      }
      const baseline = await this.#baseline(id, this.#lifetime.signal),
        facts = await this.#facts({
          sessionID: id,
          messages: [raw.id],
          cutoff: baseline.raw.revert?.messageID,
        }, baseline.controller.signal),
        context = facts.contexts[raw.id];
      if (context) {
        this.#acceptFacts(baseline, facts);
        baseline.prompt = facts.metadata.prompt;
        const message = this.#map(raw, id, context);
        if (message) this.#publish(id, { op: "message.upsert", message });
      }
      return;
    }
    // Known control-only observations have no chronological message. Any other
    // change that did not map above must consult native history, not disappear.
    if (
      event.type.startsWith("session.") && !new Set([
        "session.created",
        "session.forked",
        "session.renamed",
        "session.metadata.updated",
        "session.archived",
        "session.unarchived",
        "session.viewed",
        "session.permissions",
        "session.usage.recorded",
        "session.usage.updated",
        "session.execution.started",
        "session.inbox.delivery.changed",
      ]).has(event.type)
    ) this.#repairHistory(id, text(d.messageID) ?? text(d.assistantMessageID));
  }
  #clearRetry(session: string, messageID?: string): void {
    for (const live of this.#live.values()) {
      if (
        live.session !== session || !live.raw.retry ||
        messageID !== undefined && live.raw.id !== messageID
      ) continue;
      delete live.raw.retry;
      this.#publish(session, {
        op: "part.remove",
        messageID: live.raw.id,
        partID: `${live.raw.id}:retry`,
      });
    }
  }
  #queue(session: string, inboxID: string, kind: unknown): void {
    if (typeof kind !== "string") return;
    let known = this.#queued.get(session);
    if (!known) this.#queued.set(session, known = new Map());
    known.set(inboxID, kind);
  }
  #watchShell(
    id: string,
    raw: Extract<NativeMessage, { type: "shell" }>,
    context: MessageContext,
  ): void {
    if (this.#shells.has(raw.shellID) || !this.#subscriptions.has(id)) return;
    const baseline = this.#baselines.get(id);
    if (!baseline) return;
    const controller = new AbortController(),
      signal = AbortSignal.any([
        controller.signal,
        baseline.controller.signal,
        this.#lifetime.signal,
      ]);
    const shell: LiveShell = {
      session: id,
      raw: structuredClone(raw),
      context,
      location: { directory: baseline.raw.location.directory },
      controller,
      task: Promise.resolve(),
    };
    this.#shells.set(raw.shellID, shell);
    shell.task = this.#own(
      (async () => {
        let cursor = 0, output = "";
        while (!signal.aborted && this.#shells.get(raw.shellID) === shell) {
          const page = await this.reader.client().read(
            (api) =>
              api.shell.output({
                id: raw.shellID,
                location: shell.location,
                cursor,
                limit: Math.min(65536, Math.max(0, 1024 * 1024 - cursor)),
              }, { signal }),
            signal,
          );
          signal.throwIfAborted();
          if (this.#shells.get(raw.shellID) !== shell) {
            return;
          }
          output += page.data.output;
          cursor = page.data.cursor;
          shell.raw.output = {
            output,
            cursor,
            size: page.data.size,
            truncated: page.data.truncated || page.data.size > cursor,
          };
          const mapped = mapMessage(shell.raw, id, context);
          if (mapped) {
            this.#publish(id, { op: "message.upsert", message: mapped });
          }
          if (cursor >= 1024 * 1024) break;
          if (cursor >= page.data.size) {
            await new Promise<void>((resolve, reject) => {
              const done = () => {
                  clearTimeout(timer);
                  signal.removeEventListener("abort", abort);
                  resolve();
                },
                abort = () => {
                  clearTimeout(timer);
                  signal.removeEventListener("abort", abort);
                  reject(signal.reason);
                },
                timer = setTimeout(done, this.options.policy.retryms);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          }
        }
      })().catch((error) => {
        if (!signal.aborted) this.options.diagnostic(error);
      }).finally(() => {
        if (this.#shells.get(raw.shellID) === shell) {
          this.#shells.delete(raw.shellID);
        }
      }),
    );
  }
  #tool(
    event: V2Event,
    live: {
      session: string;
      raw: Extract<NativeMessage, { type: "assistant" }>;
      context: MessageContext;
    },
  ): void {
    const d = event.data, callID = text(d.id);
    if (!callID) return;
    let tool = live.raw.content.find((p) =>
      p.type === "tool" && p.id === callID
    ) as Extract<typeof live.raw.content[number], { type: "tool" }> | undefined;
    if (
      tool &&
      (tool.state.status === "completed" || tool.state.status === "error") &&
      event.type !== "session.tool.success" &&
      event.type !== "session.tool.failed"
    ) return;
    if (tool && event.type === "session.tool.input.started") return;
    if (
      tool && event.type.startsWith("session.tool.input.") &&
      tool.state.status !== "streaming"
    ) return;
    if (
      tool && event.type === "session.tool.called" &&
      tool.state.status !== "streaming"
    ) return;
    if (event.type === "session.tool.input.started") {
      tool = {
        type: "tool",
        id: callID,
        name: text(d.name) ?? "",
        state: { status: "streaming", input: "" },
        time: { created: event.created ?? Date.now() },
      };
      live.raw.content.push(tool);
    }
    if (!tool) {
      this.recovery.touch(
        live.session,
        live.raw.id,
        partID(live.raw.id, "tool", callID),
      );
      return;
    }
    if (
      (tool.state.status === "completed" || tool.state.status === "error") &&
      event.type !== "session.tool.success" &&
      event.type !== "session.tool.failed"
    ) return;
    if (
      event.type === "session.tool.input.delta" &&
      tool.state.status === "streaming"
    ) {
      tool.state = {
        status: "streaming",
        input: tool.state.input + (text(d.delta) ?? ""),
      };
    }
    if (event.type === "session.tool.input.ended") {
      tool.state = { status: "streaming", input: text(d.text) ?? "" };
    }
    if (event.type === "session.tool.called") {
      tool.executed = typeof d.executed === "boolean" ? d.executed : undefined;
      tool.native = d.native === undefined
        ? undefined
        : record(d.native) as NonNullable<NativeMessage["metadata"]>;
      tool.state = {
        status: "running",
        input: record(d.input),
        metadata: {},
      } as Extract<typeof tool.state, { status: "running" }>;
      tool.time.ran = event.created ?? Date.now();
    }
    if (
      event.type === "session.tool.progress" && tool.state.status === "running"
    ) {
      tool.state = {
        ...tool.state,
        metadata: record(d.metadata),
      } as typeof tool.state;
    }
    if (
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      tool.executed = d.executed === true || tool.executed === true;
      if (d.native !== undefined) {
        tool.native = {
          ...tool.native,
          ...record(d.native) as NonNullable<NativeMessage["metadata"]>,
        };
      }
      const input = record(tool.state.input);
      tool.state = {
        status: event.type.endsWith("success") ? "completed" : "error",
        input,
        ...(d.content ? { content: d.content } : {}),
        metadata: d.metadata,
        ...(d.error ? { error: d.error } : {}),
      } as typeof tool.state;
      tool.time.completed = event.created ?? Date.now();
    }
    const part = this.#helperPart(live.session, live.raw.id, {
      kind: "tool",
      id: partID(live.raw.id, "tool", callID),
      call: mapTool(tool),
      source: nativeSource("tool", tool),
    });
    this.#pruneHelpers();
    if (part) {
      this.#publish(live.session, {
        op: "part.upsert",
        messageID: live.raw.id,
        part,
        lastOutput: event.created,
      });
    }
    this.changed(live.session);
  }
  async stop(): Promise<void> {
    this.#checking = false;
    await this.colors?.stop();
    this.#lifetime.abort();
    this.#revertCommits.clear();
    this.#watermarks.clear();
    this.#anchors.clear();
    await this.requests.close();
    this.#client = undefined;
    const owned = [...this.#tasks];
    const prefetch = [...this.#prefetch.values()].map((w) => w.task);
    const shells = [...this.#shells.values()].map((w) => w.task);
    this.release();
    this.#subscriptions.clear();
    this.buffers.stop();
    await this.recovery.stop();
    await Promise.all(prefetch);
    await Promise.all(shells);
    await Promise.allSettled(owned);
  }
  #releaseHelpers(parent?: string): void {
    for (const [key, link] of this.#helperLinks) {
      if (parent === undefined || link.parent === parent) {
        this.#helperLinks.delete(key);
      }
    }
    this.#pruneHelpers();
  }
  #pruneHelpers(): void {
    for (const child of this.#helperHints) {
      if (![...this.#helperLinks.values()].some((l) => l.child === child)) {
        this.#helperHints.delete(child);
      }
    }
    for (const [child, work] of this.#helperReads) {
      if (![...this.#helperLinks.values()].some((l) => l.child === child)) {
        this.#helperReads.delete(child);
        work.controller.abort();
      }
    }
    for (const child of this.#helperProgress.keys()) {
      if (![...this.#helperLinks.values()].some((l) => l.child === child)) {
        this.#helperProgress.delete(child);
      }
    }
  }
  #decorateHelpers(message: Message): Message {
    for (const [key, link] of this.#helperLinks) {
      if (link.parent === message.sessionID && link.message === message.id) {
        this.#helperLinks.delete(key);
      }
    }
    const parts = message.parts.map((part) =>
      this.#helperPart(message.sessionID, message.id, part)
    );
    this.#pruneHelpers();
    return { ...message, parts };
  }
  #helperPart(
    parent: string,
    message: string,
    part: import("@otk/protocol").Part,
  ): import("@otk/protocol").Part {
    const key = JSON.stringify([parent, message, part.id]);
    this.#helperLinks.delete(key);
    if (
      part.kind !== "tool" || part.call.tool !== "task" ||
      !part.call.childSessionID
    ) return part;
    const child = part.call.childSessionID,
      progress = this.#helperSummary(child);
    if (this.#subscriptions.has(parent)) {
      this.#helperLinks.set(key, {
        parent,
        message,
        part: part.id,
        child,
        revision: progress.revision,
      });
      this.#requestHelper(child);
    }
    if (!this.#helperHints.has(child) && this.options.requestHelper) {
      this.#helperHints.add(child);
      this.options.requestHelper(child);
    }
    return { ...part, call: { ...part.call, progress } };
  }
  #helperSummary(child: string): import("@otk/protocol").HelperSummary {
    return this.#helperProgress.get(child) ?? this.options.helper?.(child) ?? {
      state: "digesting",
      revision: 0,
      progress: { state: "pending" },
    };
  }
  helper(child: string, summary: import("@otk/protocol").HelperSummary): void {
    // Scalar index changes invalidate only an existing viewer-owned read.
    // They never acquire helper bodies for idle/background aggregation.
    if (summary) this.#requestHelper(child, true);
  }
  #requestHelper(child: string, refresh = false): void {
    if (
      ![...this.#helperLinks.values()].some((link) =>
        link.child === child && this.#subscriptions.has(link.parent)
      )
    ) return;
    const active = this.#helperReads.get(child);
    if (active) {
      if (refresh) active.dirty = true;
      return;
    }
    if (!refresh && this.#helperProgress.has(child)) return;
    const work = { controller: new AbortController(), dirty: false };
    this.#helperReads.set(child, work);
    const signal = AbortSignal.any([
      work.controller.signal,
      this.#lifetime.signal,
    ]);
    this.#own(
      (async () => {
        do {
          work.dirty = false;
          const summary = this.options.digest
            ? await this.options.digest.read("opcv2.helper.progress", {
              sessionID: child,
            }, {
              owner: `v2-helper:${child}`,
              priority: "user",
              signal,
            })
            : await new TranscriptReads(this.reader, () => undefined)
              .helperProgress(child, signal);
          signal.throwIfAborted();
          if (this.#helperReads.get(child) !== work) return;
          if (work.dirty) continue;
          const previous = this.#helperSummary(child);
          const revision = Math.max(
            this.#helperProgress.get(child)?.revision ?? 0,
            ...[...this.#helperLinks.values()].filter((l) => l.child === child)
              .map((l) => l.revision),
          ) + 1;
          const value = {
            ...summary,
            revision,
            progress: summary.progress.state === "known"
              ? knownDerived(
                summary.progress.value,
                summary.progress.witness.source,
                revision,
                summary.progress.final,
                previous.progress,
              )
              : previous.progress.state === "known"
              ? previous.progress
              : summary.progress,
          };
          const same = value.state === previous.state &&
            (value.progress === previous.progress ||
              value.progress.state !== "known" &&
                value.progress.state === previous.progress.state);
          // Reader completion is not a progress change. Cache the result so
          // passive decoration stays quiet without advancing the client clock.
          if (same) value.revision = previous.revision;
          this.#helperProgress.set(child, value);
          if (!same) this.#publishHelper(child, value);
        } while (work.dirty);
      })().catch((error) => {
        if (!signal.aborted) {
          this.options.diagnostic(error);
          const previous = this.#helperSummary(child);
          if (
            previous.progress.state === "known" &&
            previous.state !== "unavailable"
          ) {
            const summary = {
              ...previous,
              state: "unavailable" as const,
              revision: previous.revision + 1,
            };
            this.#helperProgress.set(child, summary);
            this.#publishHelper(child, summary);
          }
        }
      }).finally(() => {
        if (this.#helperReads.get(child) === work) {
          this.#helperReads.delete(child);
          if (work.dirty && !signal.aborted) this.#requestHelper(child, true);
        }
      }),
    );
  }
  #publishHelper(
    child: string,
    summary: import("@otk/protocol").HelperSummary,
  ): void {
    for (const link of this.#helperLinks.values()) {
      if (
        link.child !== child || summary.revision <= link.revision ||
        !this.#subscriptions.has(link.parent)
      ) continue;
      link.revision = summary.revision;
      this.#publish(link.parent, {
        op: "task.progress",
        messageID: link.message,
        partID: link.part,
        childSessionID: child,
        summary,
      });
    }
  }
}
import { markdown as importMarkdown } from "@otk/content";
/** Full operations only. Delta blocks require their seeded event stream. */
function overlay(items: Message[], op: ContentOp): Message[] {
  if (op.op === "message.remove") {
    return items.filter((m) => m.id !== op.messageID);
  }
  if (op.op === "message.upsert") {
    const old = items.find((m) => m.id === op.message.id);
    if (
      old?.role === "assistant" && isAssistantTerminal(old) &&
      op.message.role === "assistant" &&
      !isAssistantTerminal(op.message) && !op.restart
    ) return items;
    return [...items.filter((m) => m.id !== op.message.id), {
      ...op.message,
      parts: op.message.parts.length ? op.message.parts : old?.parts ?? [],
    }].sort(compareMessages);
  }
  if (op.op !== "part.upsert" && op.op !== "part.remove") return items;
  return items.map((m) => {
    if (m.id !== op.messageID) return m;
    const partID = op.op === "part.upsert" ? op.part.id : op.partID;
    const parts = [...m.parts], index = parts.findIndex((p) => p.id === partID);
    if (op.op === "part.remove") {
      return {
        ...m,
        parts: parts.filter((p) => p.id !== partID),
      };
    }
    if (index < 0) parts.push(op.part);
    else parts[index] = op.part;
    return { ...m, parts };
  });
}
