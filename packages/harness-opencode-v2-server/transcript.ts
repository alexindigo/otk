// SPDX-License-Identifier: LGPL-3.0-only
import { ContentReplay, HarnessError } from "@otk/harness";
import type { DigestPort } from "@otk/harness";
import { StreamBuffers } from "@otk/content";
import {
  compareMessages,
  isRealPrompt,
  MAX_MESSAGE_CURSOR_LENGTH,
  MESSAGE_PAGE_SIZE,
} from "@otk/protocol";
import type {
  ContentOp,
  LatestPrompt,
  Message,
  MessagePage,
  MessagePolicy,
  TranscriptInvalidation,
} from "@otk/protocol";
import type { V2Client } from "./client.ts";
import {
  Messages,
  nativeCursor,
  nativeForwardCursor,
  type NativeMessage,
  type NativeSession,
  SCAN_ROWS,
} from "./messages.ts";
import {
  completeTokens,
  mapMessage,
  mapTool,
  type MessageContext,
  millis,
  partID,
  record,
  text,
} from "./map.ts";
import {
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
interface Baseline {
  raw: NativeSession;
  epoch: string;
  controller: AbortController;
  prompt?: LatestPrompt;
  contexts: Map<string, MessageContext>;
  source?: string;
  presentation?: import("@otk/protocol").ContentSession;
}
interface Cursor {
  v: 2;
  session: string;
  epoch: string;
  cutoff: string | null;
  native: string;
  source: string;
}
interface LiveShell {
  session: string;
  raw: Extract<NativeMessage, { type: "shell" }>;
  context: MessageContext;
  location: { directory: string };
  controller: AbortController;
  task: Promise<void>;
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
function decode(token: string): Cursor {
  try {
    if (
      !token || token.length > MAX_MESSAGE_CURSOR_LENGTH ||
      !/^[\w-]+$/.test(token)
    ) throw new Error();
    const v = JSON.parse(atob(token.replaceAll("-", "+").replaceAll("_", "/")));
    if (
      Object.keys(v).sort().join() !== "cutoff,epoch,native,session,source,v" ||
      v.v !== 2 || typeof v.session !== "string" ||
      typeof v.epoch !== "string" || typeof v.native !== "string" ||
      !v.native || typeof v.source !== "string" || !v.source ||
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
  #client?: V2Client;
  #shells = new Map<string, LiveShell>();
  #projected = new Map<
    string,
    { shells: Map<string, string>; compaction?: string }
  >();
  #finished = new Map<string, Map<string, number>>();
  #boundaries = new Map<string, string>();
  #tasks = new Set<Promise<unknown>>();
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
  }
  constructor(
    readonly options: {
      client(): V2Client;
      policy: MessagePolicy;
      digest?: DigestPort;
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
      summaries?(
        id: string,
        turns: readonly string[],
      ): Record<string, import("@otk/protocol").UsageSummary>;
      helper?(id: string): import("@otk/protocol").HelperSummary | undefined;
      requestHelper?(id: string): void;
    },
  ) {
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
      read: (id, message, signal) => this.reader.get(id, message, signal),
      emit: async (id, raw, _parts, _generation, terminal, signal) => {
        if (terminal && raw.type === "assistant" && !raw.time.completed) {
          throw new Error("Native response checkpoint is not settled yet");
        }
        const baseline = await this.#baseline(id, signal),
          facts = await this.#facts({
            sessionID: id,
            messages: [raw.id],
            cutoff: baseline.raw.revert?.messageID,
          }, signal);
        signal.throwIfAborted();
        const context = facts.contexts[raw.id];
        if (!context) return;
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
  #publish(id: string, event: ContentOp): void {
    if (this.#subscriptions.has(id) && !this.#lifetime.signal.aborted) {
      this.replay.publish(id, event);
    }
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
    for (const [id, context] of Object.entries(facts.contexts)) {
      baseline.contexts.set(id, context);
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
      this.release(id);
    }
  }
  release(id?: string): void {
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
      if (id === undefined || value.session === id) this.#live.delete(key);
    }
    if (id === undefined) this.buffers.reset();
    else this.buffers.removeSession(id);
    this.replay.reset(id);
    if (id) this.options.digest?.release(`v2-prefetch:${id}`);
  }
  invalidate(id?: string, retain = false): void {
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
    this.#cancelBackfills();
    this.#releaseHelpers();
    this.buffers.suspend();
    this.changed();
    this.recovery.release();
    for (const shell of this.#shells.values()) shell.controller.abort();
    this.#shells.clear();
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
      : true;
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
      }
    }
    if (raw.type === "assistant" && !raw.time.completed) {
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
    let mapped = mapMessage(raw, id, context);
    if (!mapped) return;
    mapped = this.#decorateHelpers(mapped);
    if (raw.type === "shell" || raw.type === "compaction") {
      let known = this.#projected.get(id);
      if (!known) this.#projected.set(id, known = { shells: new Map() });
      if (raw.type === "compaction") known.compaction = raw.id;
      else {
        known.shells.set(raw.shellID, raw.id);
        if (raw.status === "running") this.#watchShell(id, raw, context);
      }
    }
    if (raw.type !== "assistant") return mapped;
    if (!raw.time.completed && !this.#finished.get(id)?.has(raw.id)) {
      this.#live.set(raw.id, {
        session: id,
        raw: structuredClone(raw),
        context,
      });
    }
    if (raw.time.completed || terminal) {
      this.#live.delete(raw.id);
      let finished = this.#finished.get(id);
      if (!finished) this.#finished.set(id, finished = new Map());
      finished.set(raw.id, millis(raw.time.completed));
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
  async #page(
    id: string,
    before?: string,
    signal: AbortSignal = new AbortController().signal,
    publish?: (page: MessagePage) => void,
  ): Promise<MessagePage> {
    ids.decode(id);
    signal.throwIfAborted();
    const token = before === undefined ? undefined : decode(before);
    let baseline = this.#baselines.get(id);
    if (
      token &&
      (!baseline || token.session !== id ||
        token.epoch !== this.replay.clock(id).epoch ||
        token.cutoff !== (baseline.raw.revert?.messageID ?? null) ||
        token.source !== baseline.source)
    ) {
      throw new HarnessError(
        "cursor-stale",
        "Messages changed. Refresh messages before continuing.",
      );
    }
    const capture = this.replay.capture(id);
    try {
      baseline ??= await this.#baseline(id, signal);
      const owner = baseline;
      signal = AbortSignal.any([
        signal,
        owner.controller.signal,
        this.#lifetime.signal,
      ]);
      const cutoff = owner.raw.revert?.messageID,
        compatible =
          (this.#client ?? this.options.client()).service.version === "2.2.6",
        native = token?.native ??
          (cutoff && compatible ? nativeCursor(cutoff) : undefined);
      const cached = native
        ? this.#cache?.get(this.#key(id, owner, native))
        : undefined;
      if (!cached && native) {
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
      this.#acceptFacts(owner, facts);
      let items = page.items.flatMap((raw) => {
        const context = facts!.contexts[raw.id];
        if (!context) {
          throw new HarnessError(
            "capture-stale",
            "Message metadata changed during page capture",
          );
        }
        const mapped = this.#map(raw, id, context);
        return mapped ? [mapped] : [];
      }).sort(compareMessages);
      this.buffers.epoch(id, owner.epoch);
      this.buffers.checkpoint(id, (sid, op) => this.#publish(sid, op));
      items = items.map((m) => this.buffers.overlay(m));
      signal.throwIfAborted();
      if (
        owner !== this.#baselines.get(id) ||
        owner.epoch !== this.replay.clock(id).epoch
      ) throw new HarnessError("cursor-stale", "Message baseline was replaced");
      owner.presentation ??= await revertSession(
        this.reader.client(),
        owner.raw,
        signal,
      );
      signal.throwIfAborted();
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
      });
      if (this.recovery.scoped(id)) {
        for (const m of items) {
          if (m.role === "assistant" && m.time.completed === undefined) {
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
      const covered = new Set(page.items.map((m) => m.id));
      items = items.filter((m) => covered.has(m.id));
      const turnIDs = [
        ...new Set(
          items.flatMap((m) =>
            m.role === "assistant" ? [m.replyTo ?? m.id] : []
          ),
        ),
      ];
      const result: MessagePage = {
        sessionID: id,
        version: this.replay.version(id),
        from: capture.from,
        clock: sealed.clock,
        session: owner.presentation,
        items,
        older: page.next
          ? encode({
            v: 2,
            session: id,
            epoch: owner.epoch,
            cutoff: cutoff ?? null,
            native: page.next,
            source: facts.source,
          })
          : null,
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
      this.recovery.retry(id);
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
  async event(event: V2Event): Promise<void> {
    const d = event.data, sid = text(d.sessionID);
    if (!sid || sid === "global") return;
    const id = ids.encode(sid);
    if (/^session\.(tool\.|execution\.)/.test(event.type)) {
      this.#requestHelper(id, true);
    }
    if (
      event.type.startsWith("session.") &&
      !event.type.startsWith("session.execution.")
    ) this.changed(id);
    if (/^session\.revert\./.test(event.type)) {
      const revert = event.type === "session.revert.staged"
        ? d.revert
        : undefined;
      this.#boundary(
        id,
        revert,
        event.type === "session.revert.committed" && !this.#boundaries.has(id),
      );
      return;
    }
    if (event.type === "session.deleted") {
      this.release(id);
      return;
    }
    if (!this.#subscriptions.has(id)) return;
    const sourceID = event.id?.replace(/^evt_/, "msg_");
    const contextFor = (messageID: string): MessageContext => {
      const baseline = this.#baselines.get(id);
      const existing = baseline?.contexts.get(messageID);
      if (existing) return existing;
      const context = {
        order: baseline?.source?.startsWith("api")
          ? Math.max(
            0,
            ...[...baseline.contexts.values()].map((c) => c.order),
          ) + 1
          : event.durable?.seq ?? ++this.#revisions,
        replyTo: baseline?.prompt?.id,
      };
      baseline?.contexts.set(messageID, context);
      return context;
    };
    if (
      event.type === "session.inbox.cancelled" && typeof d.inboxID === "string"
    ) {
      this.#publish(id, { op: "message.remove", messageID: d.inboxID });
      this.changed(id);
      return;
    }
    if (
      event.type === "session.inbox.enqueued" && typeof d.inboxID === "string"
    ) {
      const item = record(d.item), payload = record(item.payload);
      if (item.type === "compaction") {
        const raw: Extract<NativeMessage, { type: "compaction" }> = {
          type: "compaction",
          id: d.inboxID,
          status: "running",
          reason: "manual",
          summary: "",
          time: { created: event.created ?? Date.now() },
        };
        const message = mapMessage(raw, id, contextFor(raw.id))!;
        message.parts = message.parts.map((part) =>
          part.kind === "compaction" ? { ...part, status: "queued" } : part
        );
        this.#publish(id, { op: "message.upsert", message });
      }
      if (item.type === "user" && typeof payload.text === "string") {
        const raw = {
          type: "user",
          id: d.inboxID,
          text: payload.text,
          files: payload.files,
          agents: payload.agents,
          skills: payload.skills,
          time: { created: event.created ?? Date.now() },
        } as Extract<NativeMessage, { type: "user" }>;
        this.#publish(id, {
          op: "message.upsert",
          message: mapMessage(raw, id, contextFor(raw.id))!,
        });
      }
      return;
    }
    if (
      sourceID &&
      (event.type === "session.synthetic" ||
        event.type === "session.instructions.updated" ||
        event.type === "session.skill.activated")
    ) {
      if (typeof d.text !== "string") return;
      const raw = {
        id: sourceID,
        type: event.type === "session.synthetic"
          ? "synthetic"
          : event.type === "session.instructions.updated"
          ? "system"
          : "skill",
        text: d.text,
        ...(event.type === "session.skill.activated"
          ? { skill: d.id, name: d.name }
          : {}),
        time: { created: event.created ?? Date.now() },
      } as NativeMessage;
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
        return;
      }
      let nativeID = this.#projected.get(id)?.shells.get(shell.id) ??
        (event.type.endsWith("started") ? sourceID : undefined);
      let raw: Extract<NativeMessage, { type: "shell" }> | undefined;
      if (!nativeID) {
        let cursor: string | undefined;
        do {
          const page = await this.reader.page(
            id,
            SCAN_ROWS,
            cursor,
            this.#lifetime.signal,
            "shell",
          );
          raw = page.items.find((
            m,
          ): m is Extract<NativeMessage, { type: "shell" }> =>
            m.type === "shell" && m.shellID === shell.id
          );
          if (raw) {
            nativeID = raw.id;
            break;
          }
          cursor = page.next;
        } while (cursor);
      }
      if (!nativeID) return;
      const previous = this.#shells.get(shell.id);
      if (event.type.endsWith("ended")) {
        previous?.controller.abort();
        this.#shells.delete(shell.id);
      }
      raw ??= {
        id: nativeID,
        type: "shell",
        shellID: shell.id,
        command: shell.command,
        status: shell.status,
        time: {
          created: previous?.raw.time.created ??
            millis(record(shell.time).started) ?? event.created ?? Date.now(),
          ...(event.type.endsWith("ended")
            ? { completed: event.created ?? Date.now() }
            : {}),
        },
        ...(d.output ? { output: d.output } : {}),
        exit: shell.exit,
      } as Extract<NativeMessage, { type: "shell" }>;
      const message = this.#map(raw, id, contextFor(nativeID));
      if (message) this.#publish(id, { op: "message.upsert", message });
      this.changed(id);
      return;
    }
    if (event.type.startsWith("session.compaction.") && sourceID) {
      const known = this.#projected.get(id)?.compaction,
        nativeID = text(d.inputID) ??
          (event.type.endsWith("started") ? sourceID : known ?? sourceID);
      const status = event.type.endsWith("started")
        ? "running"
        : event.type.endsWith("failed")
        ? "failed"
        : "completed";
      const pid = partID(nativeID, "text", 0);
      if (event.type.endsWith("delta")) {
        if (
          !this.buffers.append(
            pid,
            text(d.text) ?? "",
            (session, op) => this.#publish(session, op),
          )
        ) this.recovery.touch(id, nativeID, pid);
        return;
      }
      const raw = {
        id: nativeID,
        type: "compaction",
        status,
        reason: d.reason ?? "manual",
        summary: text(d.text) ?? "",
        ...(d.error ? { error: d.error } : {}),
        time: { created: event.created ?? Date.now() },
      } as Extract<NativeMessage, { type: "compaction" }>;
      const message = this.#map(raw, id, contextFor(nativeID));
      if (message) this.#publish(id, { op: "message.upsert", message });
      if (status === "running") {
        this.buffers.upsert(id, nativeID, {
          kind: "text",
          id: pid,
          synthetic: false,
          blocks: [],
        }, "");
        this.#publish(id, {
          op: "part.upsert",
          messageID: nativeID,
          part: this.buffers.snapshot(pid)!.part,
        });
      } else {
        this.buffers.remove(pid);
        this.recovery.message(nativeID, id);
      }
      this.changed(id);
      return;
    }
    if (
      event.type === "session.agent.selected" ||
      event.type === "session.model.selected"
    ) {
      const baseline = this.#baselines.get(id);
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
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      this.recovery.terminal(id);
      return;
    }
    const messageID = text(d.assistantMessageID);
    const finished = messageID
      ? this.#finished.get(id)?.get(messageID)
      : undefined;
    if (finished !== undefined) {
      if (
        event.type === "session.step.started" && (event.created ?? 0) > finished
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
      ) return;
      const raw: Extract<NativeMessage, { type: "assistant" }> = {
        id: messageID,
        type: "assistant",
        agent: d.agent,
        model: { id: model.id, providerID: model.providerID },
        content: existing?.raw.content ?? [],
        time: {
          created: typeof d.started === "number"
            ? d.started
            : event.created ?? Date.now(),
        },
      };
      const baseline = this.#baselines.get(id),
        context = existing?.context ?? baseline?.contexts.get(messageID) ?? {
          order: baseline?.source?.startsWith("api")
            ? Math.max(
              0,
              ...[...baseline.contexts.values()].map((c) => c.order),
            ) + 1
            : event.durable?.seq ?? ++this.#revisions,
          replyTo: baseline?.prompt?.id,
        };
      baseline?.contexts.set(messageID, context);
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
        const kind = event.type.includes(".reasoning.") ? "reasoning" : "text",
          ordinal = d.ordinal;
        if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0) return;
        const pid = partID(messageID, kind, Number(ordinal));
        const previous = this.buffers.snapshot(pid, id, messageID)?.part;
        const shell = kind === "text"
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
          ) this.recovery.touch(id, messageID, pid);
          return;
        }
        if (event.type.endsWith(".started")) {
          if (
            live?.raw.content.filter((p) => p.type === kind)[Number(ordinal)]
          ) return;
          this.buffers.upsert(id, messageID, shell, "");
          this.#publish(id, {
            op: "part.upsert",
            messageID,
            part: this.buffers.snapshot(pid)!.part,
          });
          this.recovery.part(messageID, pid, id);
          return;
        }
        if (event.type.endsWith(".ended") && typeof d.text === "string") {
          const finished =
            this.buffers.finishPart(id, messageID, shell, d.text) ??
              { ...shell, blocks: importMarkdown(d.text) };
          this.#publish(id, {
            op: "part.upsert",
            messageID,
            part: finished,
            lastOutput: event.created,
          });
          this.recovery.part(messageID, pid, id);
          return;
        }
      }
      if (
        event.type === "session.step.ended" ||
        event.type === "session.step.failed"
      ) {
        if (!live) {
          this.recovery.touch(id, messageID, `${messageID}:finish`);
          this.recovery.terminal(id, messageID);
          return;
        }
        const raw = {
          ...live.raw,
          ...(d.cost !== undefined ? { cost: d.cost } : {}),
          ...(d.tokens !== undefined ? { tokens: d.tokens } : {}),
          ...(d.error ? { error: d.error } : {}),
          time: { ...live.raw.time, completed: event.created ?? Date.now() },
        } as typeof live.raw;
        this.buffers.complete(
          messageID,
          (session, op) => this.#publish(session, op),
        );
        const header = mapMessage(raw, id, live.context)!;
        header.parts = [];
        this.#publish(id, { op: "message.upsert", message: header });
        this.#publish(id, {
          op: "part.upsert",
          messageID,
          part: {
            kind: "step",
            id: `${messageID}:finish`,
            phase: "finish",
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
        finished.set(messageID, event.created ?? Date.now());
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
    if (
      /^(session\.inbox\.delivered)$/
        .test(event.type)
    ) {
      this.changed(id);
      const nativeID = event.type === "session.inbox.delivered"
        ? text(d.inboxID)
        : event.id?.replace(/^evt_/, "msg_");
      if (nativeID) {
        const raw = await this.reader.get(id, nativeID, this.#lifetime.signal),
          baseline = await this.#baseline(id, this.#lifetime.signal),
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
      }
    }
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
    this.#lifetime.abort();
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
      toolCount: null,
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
          const revision = Math.max(
            this.#helperProgress.get(child)?.revision ?? 0,
            ...[...this.#helperLinks.values()].filter((l) => l.child === child)
              .map((l) => l.revision),
          ) + 1;
          const value = { ...summary, revision };
          this.#helperProgress.set(child, value);
          this.#publishHelper(child, value);
        } while (work.dirty);
      })().catch((error) => {
        if (!signal.aborted) this.options.diagnostic(error);
      }).finally(() => {
        if (this.#helperReads.get(child) === work) {
          this.#helperReads.delete(child);
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
      old?.role === "assistant" && old.time.completed !== undefined &&
      op.message.role === "assistant" &&
      op.message.time.completed === undefined && !op.restart
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
