// SPDX-License-Identifier: LGPL-3.0-only
import { NATIVE_SCAN_ROWS } from "./messages.ts";
import {
  type ContentReplay,
  HarnessError,
  type TranscriptMetadata,
} from "@otk/harness";
import {
  type ContentOp,
  type ContentSession,
  type LatestPrompt,
  MAX_MESSAGE_CURSOR_LENGTH,
  type Message,
  MESSAGE_PAGE_SIZE,
  type MessagePage,
  type TranscriptInvalidation,
  withHelperProgress,
} from "@otk/protocol";
import type { StreamBuffers } from "@otk/content";
import type { Messages, NativeMessage } from "./messages.ts";
import type { Session } from "./types.ts";
import { mapMessage, mapPart } from "./map.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";

interface Cursor {
  v: 1;
  session: string;
  epoch: string;
  cutoff: string | null;
  native: string;
}
interface Baseline {
  raw: Session;
  controller: AbortController;
  info?: Promise<ContentSession>;
  epoch: string;
  prompt?: LatestPrompt;
  promptReady?: boolean;
}
function encode(value: Cursor): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(token: string): Cursor {
  try {
    if (
      !token.length || token.length > MAX_MESSAGE_CURSOR_LENGTH ||
      !/^[\w-]+$/.test(token)
    ) throw new Error();
    const value = JSON.parse(
      atob(token.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      Object.keys(value).sort().join() !== "cutoff,epoch,native,session,v" ||
      value.v !== 1 || typeof value.session !== "string" ||
      typeof value.epoch !== "string" || typeof value.native !== "string" ||
      !value.native ||
      (value.cutoff !== null && typeof value.cutoff !== "string")
    ) throw new Error();
    return value;
  } catch {
    throw new HarnessError(
      "cursor-stale",
      "Message continuation is no longer valid. Refresh messages.",
    );
  }
}
function prompt(message: Message | undefined): LatestPrompt | undefined {
  if (message?.role !== "user") return;
  return {
    id: message.id,
    agent: message.agent,
    model: message.model,
    variant: message.variant,
  };
}
/** Exact continuation, raw session/cutoff and event-aligned page authority. */
export class Transcript {
  #baselines = new Map<string, Baseline>();
  #opening = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<Baseline>;
      users: number;
      settled: boolean;
      observed?: Session;
    }
  >();
  constructor(
    readonly options: {
      replay: ContentReplay;
      invalidated?(value: TranscriptInvalidation): void;
      retire?(id?: string): void;
      recovering?(id: string): MessagePage["recovering"];
      scopedRecovery?(id: string): boolean;
      retryRecovery?(id: string): void;
      buffers: StreamBuffers;
      reader: Messages;
      raw(id: string, signal?: AbortSignal): Promise<Session>;
      info(raw: Session, signal?: AbortSignal): Promise<ContentSession>;
      metadata?(
        id: string,
        turns: readonly string[],
        signal: AbortSignal,
        cutoff?: string,
      ): Promise<TranscriptMetadata>;
      decorate(
        message: Message,
        raw: NativeMessage,
        directory: string,
      ): Message | Promise<Message>;
      summaries(
        id: string,
        turns: readonly string[],
      ): Record<string, import("@otk/protocol").UsageSummary>;
    },
  ) {}
  observe(raw: Session): void {
    const id = ids.encode(raw.id), previous = this.#baselines.get(id);
    const opening = this.#opening.get(id);
    if (!previous && !opening) return;
    if (!previous && opening) {
      // An update is not a body boundary. Keep the newest event metadata with
      // the acquisition owner; compare its cutoff when the raw read settles.
      if (
        !opening.observed ||
        opening.observed.revert?.messageID === raw.revert?.messageID
      ) {
        opening.observed = raw;
        return;
      }
      this.invalidate(id);
      this.options.buffers.removeSession(id);
    }
    if (previous && previous.raw.revert?.messageID !== raw.revert?.messageID) {
      this.invalidate(id);
      this.options.buffers.removeSession(id);
    }
    const current = this.#baselines.get(id);
    if (current) {
      current.raw = raw;
      current.info = undefined;
    } else {
      this.#baselines.set(id, {
        raw,
        epoch: this.options.replay.clock(id).epoch,
        controller: new AbortController(),
      });
    }
  }
  release(id?: string): void {
    this.#retire(id);
    this.options.replay.reset(id);
  }
  invalidate(id?: string): void {
    this.#retire(id);
    const value = this.options.replay.invalidate(id);
    this.options.invalidated?.(value);
  }
  #retire(id?: string): void {
    this.options.retire?.(id);
    for (const [key, opening] of this.#opening) {
      if (id !== undefined && key !== id) continue;
      this.#opening.delete(key);
      opening.controller.abort(
        new HarnessError("cursor-stale", "Message baseline was retired"),
      );
    }
    for (const [key, baseline] of this.#baselines) {
      if (id === undefined || id === key) baseline.controller.abort();
    }
    if (id === undefined) this.#baselines.clear();
    else this.#baselines.delete(id);
  }
  async #read(id: string, signal: AbortSignal): Promise<Baseline> {
    signal.throwIfAborted();
    const existing = this.#baselines.get(id);
    if (existing) return existing;
    let opening = this.#opening.get(id);
    if (!opening) {
      const controller = new AbortController(),
        epoch = this.options.replay.clock(id).epoch;
      const owner = {
        controller,
        users: 0,
        settled: false,
        observed: undefined as Session | undefined,
        promise: Promise.resolve(undefined as unknown as Baseline),
      };
      this.#opening.set(id, owner);
      owner.promise = Promise.resolve().then(() =>
        this.options.raw(id, controller.signal)
      ).then((raw) => {
        controller.signal.throwIfAborted();
        if (ids.encode(raw.id) !== id) {
          throw new HarnessError("session", "Session identity mismatch");
        }
        if (epoch !== this.options.replay.clock(id).epoch) {
          throw new HarnessError(
            "cursor-stale",
            "Message baseline was retired",
          );
        }
        if (owner.observed) {
          if (owner.observed.revert?.messageID !== raw.revert?.messageID) {
            this.invalidate(id);
            this.options.buffers.removeSession(id);
            throw new HarnessError("cursor-stale", "Message boundary changed");
          }
          if (owner.observed.time.updated >= raw.time.updated) {
            raw = owner.observed;
          }
        }
        const baseline: Baseline = { raw, epoch, controller };
        this.#baselines.set(id, baseline);
        return baseline;
      }).finally(() => {
        owner.settled = true;
        if (this.#opening.get(id) === owner) this.#opening.delete(id);
      });
      opening = owner;
    }
    const owner = opening;
    owner.users++;
    const combined = AbortSignal.any([signal, owner.controller.signal]);
    const result = Promise.withResolvers<Baseline>();
    const cancel = () => result.reject(combined.reason);
    combined.addEventListener("abort", cancel, { once: true });
    if (combined.aborted) cancel();
    void owner.promise.then(result.resolve, result.reject);
    try {
      return await result.promise;
    } finally {
      combined.removeEventListener("abort", cancel);
      if (--owner.users === 0 && !owner.settled) {
        if (this.#opening.get(id) === owner) this.#opening.delete(id);
        owner.controller.abort();
      }
    }
  }
  async session(id: string, signal?: AbortSignal): Promise<ContentSession> {
    ids.decode(id);
    // Point metadata has an independent caller lifetime. Body retirement must
    // fence its old response, not turn an accepted revert/restore into failure.
    while (true) {
      signal?.throwIfAborted();
      const epoch = this.options.replay.clock(id).epoch;
      try {
        let baseline: Baseline;
        const previous = this.#baselines.get(id);
        if (!previous || this.#opening.has(id)) {
          baseline = await this.#read(
            id,
            signal ?? new AbortController().signal,
          );
        } else {
          const raw = await this.options.raw(id, signal);
          signal?.throwIfAborted();
          if (epoch !== this.options.replay.clock(id).epoch) {
            const current = this.#baselines.get(id);
            if (!current) continue;
            baseline = current;
          } else {
            this.observe(raw);
            baseline = this.#baselines.get(id)!;
          }
        }
        const result = await (baseline.info ??= this.options.info(
          baseline.raw,
          baseline.controller.signal,
        ));
        signal?.throwIfAborted();
        if (baseline !== this.#baselines.get(id)) continue;
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (epoch !== this.options.replay.clock(id).epoch) continue;
        throw error;
      }
    }
  }
  async page(
    id: string,
    before?: string,
    signal = new AbortController().signal,
  ): Promise<MessagePage> {
    ids.decode(id);
    signal.throwIfAborted();
    const { replay, buffers, reader } = this.options;
    const token = before === undefined ? undefined : decode(before);
    let baseline = this.#baselines.get(id);
    if (
      token &&
      (!baseline || token.session !== id ||
        token.epoch !== replay.clock(id).epoch ||
        token.cutoff !== (baseline.raw.revert?.messageID ?? null))
    ) {
      throw new HarnessError(
        "cursor-stale",
        "Messages changed. Refresh messages before continuing.",
      );
    }
    const capture = replay.capture(id);
    try {
      if (!token) this.options.retryRecovery?.(id);
      baseline ??= await this.#read(id, signal);
      const owner = baseline;
      signal = AbortSignal.any([signal, owner.controller.signal]);
      const cutoff = owner.raw.revert?.messageID;
      let native = token?.native;
      let metadata: TranscriptMetadata | undefined;
      if (!token && cutoff) {
        metadata = await this.options.metadata?.(id, [], signal, cutoff);
        const created = metadata?.cutoffCreated ??
          (await reader.get(id, cutoff, signal, owner.raw.directory)).info.time
            .created;
        native = reader.cursor(cutoff, created);
      }
      const page = await reader.page(
        id,
        MESSAGE_PAGE_SIZE,
        native,
        owner.raw.directory,
        signal,
      );
      signal.throwIfAborted();
      let items = await Promise.all(
        page.items.filter(({ info }) => !cutoff || info.id < cutoff).map((
          raw,
        ) =>
          this.options.decorate(
            mapMessage(raw.info, raw.parts, undefined, (part) =>
              raw.info.role === "assistant" &&
                raw.info.time.completed === undefined
                ? buffers.snapshot(part.id, id, raw.info.id)?.part ??
                  mapPart(part)
                : mapPart(part)),
            raw,
            owner.raw.directory,
          )
        ),
      );
      const turns = [
        ...new Set(
          items.filter((m) => m.role === "assistant").map((m) =>
            m.role === "assistant" ? m.replyTo ?? m.id : m.id
          ),
        ),
      ];
      if (this.options.metadata) {
        metadata = await this.options.metadata(id, turns, signal, cutoff);
      } else if (token && owner.promptReady) {
        metadata = { boundaries: [], prompt: owner.prompt };
      } else {
        const latest = items.findLast((m) => m.role === "user");
        metadata = { boundaries: [], prompt: prompt(latest) };
        // A standalone adapter has no worker: bounded native pages retain only
        // the latest user's scalar header, never another transcript collection.
        let continuation = page.next;
        while (!latest && continuation) {
          const scan = await reader.page(
            id,
            NATIVE_SCAN_ROWS,
            continuation,
            owner.raw.directory,
            signal,
          );
          const row = scan.items.findLast(({ info }) =>
            info.role === "user" && (!cutoff || info.id < cutoff)
          );
          if (row) {
            metadata.prompt = prompt(mapMessage(row.info, []));
            break;
          }
          continuation = scan.next;
        }
      }
      owner.prompt = metadata?.prompt;
      owner.promptReady = true;
      const session = await (owner.info ??= this.options.info(
        owner.raw,
        owner.controller.signal,
      ));
      signal.throwIfAborted();
      if (
        owner !== this.#baselines.get(id) ||
        owner.epoch !== replay.clock(id).epoch
      ) throw new HarnessError("cursor-stale", "Message baseline was replaced");
      buffers.epoch(id, owner.epoch);
      buffers.checkpoint(
        id,
        (sessionID, event) => replay.publish(sessionID, event),
      );
      items = items.map((message) => buffers.overlay(message));
      const sealed = capture.seal();
      // A synchronous source checkpoint supersedes every captured suffix for
      // that part. Never replay a suffix over freshly parsed HTTP blocks.
      const replacements = new Map<string, number>();
      sealed.events.forEach(({ event }, i) => {
        if (event.op === "part.upsert") {
          replacements.set(`${event.messageID}/${event.part.id}`, i);
        }
        if (event.op === "part.remove") {
          replacements.set(`${event.messageID}/${event.partID}`, i);
        }
      });
      const recovering: MessagePage["recovering"] =
        this.options.recovering?.(id) ?? [];
      // Fine keys lost to overflow are replaced by one scoped intent. A page
      // reconciles visible HTTP bodies, without claiming they seed native deltas.
      if (this.options.scopedRecovery?.(id)) {
        items = items.map((message) => {
          if (
            message.role !== "assistant" || message.time.completed !== undefined
          ) return message;
          return {
            ...message,
            parts: message.parts.map((part) => {
              if (
                (part.kind !== "text" && part.kind !== "reasoning") ||
                buffers.snapshot(part.id)
              ) return part;
              const stream = buffers.replacement(id);
              recovering.push({
                messageID: message.id,
                partID: part.id,
                generation: stream.generation,
              });
              return { ...part, stream };
            }),
          };
        });
      }
      const catchup = sealed.events.filter(({ event }, i) => {
        if (event.op !== "part.blocks") return true;
        if (
          (replacements.get(`${event.messageID}/${event.partID}`) ?? -1) > i
        ) return false;
        recovering.push({
          messageID: event.messageID,
          partID: event.partID,
          generation: event.stream.generation,
        });
        return false;
      });
      for (const { event } of catchup) {
        items = overlay(items, event);
        if (
          event.op === "message.upsert" && event.message.role === "user" &&
          (!metadata?.prompt || event.message.id >= metadata.prompt.id)
        ) {
          metadata = {
            ...metadata,
            boundaries: metadata?.boundaries ?? [],
            prompt: prompt(event.message),
          };
        }
        if (
          event.op === "message.remove" &&
          event.messageID === metadata?.prompt?.id
        ) {
          throw new HarnessError(
            "capture-stale",
            "Latest prompt changed during page capture",
          );
        }
      }
      owner.prompt = metadata?.prompt;
      // Catchup-created messages are not historical collection items. Their
      // complete operations travel separately and are installed atomically.
      const covered = new Set(page.items.map((m) => m.info.id));
      items = items.filter((m) => covered.has(m.id));
      const helpers: MessagePage["helpers"] = {};
      for (const m of items) {
        for (const part of m.parts) {
          if (part.kind === "tool" && part.call.childSessionID) {
            helpers[part.call.childSessionID] =
              part.call.tool === "task" && part.call.progress
                ? part.call.progress
                : {
                  state: "digesting",
                  revision: 0,
                  toolCount: null,
                };
          }
        }
      }
      const summaries = this.options.summaries(id, turns);
      return {
        sessionID: id,
        version: replay.version(id),
        from: capture.from,
        clock: sealed.clock,
        session,
        items,
        older: page.next
          ? encode({
            v: 1,
            session: id,
            epoch: owner.epoch,
            cutoff: cutoff ?? null,
            native: page.next,
          })
          : null,
        prompt: metadata?.prompt,
        catchup,
        helpers,
        recovering,
        turns: Object.fromEntries(
          turns.map((
            turnID,
          ) => [turnID, {
            summary: summaries[turnID],
            boundary: metadata?.boundaries.find((b) => b.turnID === turnID) ??
              { turnID, complete: false },
          }]),
        ),
      };
    } finally {
      capture.release();
    }
  }
}
/** Apply only full identity replacements; source suffixes never enter here. */
function overlay(items: Message[], event: ContentOp): Message[] {
  if (event.op === "message.remove") {
    return items.filter((m) => m.id !== event.messageID);
  }
  if (event.op === "message.upsert") {
    const previous = items.find((m) => m.id === event.message.id);
    if (
      previous?.role === "assistant" && previous.time.completed !== undefined &&
      event.message.role === "assistant" &&
      event.message.time.completed === undefined
    ) return items;
    const value = {
      ...event.message,
      parts: event.message.parts.length
        ? event.message.parts
        : previous?.parts ?? [],
    };
    return [...items.filter((m) => m.id !== value.id), value].sort((a, b) =>
      a.time.created - b.time.created || a.id.localeCompare(b.id)
    );
  }
  if (event.op === "task.progress") {
    return items.map((message) =>
      message.id !== event.messageID ? message : {
        ...message,
        parts: message.parts.map((part) =>
          part.id === event.partID
            ? withHelperProgress(part, event.childSessionID, event.summary)
            : part
        ),
      }
    );
  }
  if (event.op !== "part.upsert" && event.op !== "part.remove") return items;
  return items.map((message) => {
    if (message.id !== event.messageID) return message;
    if (event.op === "part.remove") {
      return {
        ...message,
        parts: message.parts.filter((p) => p.id !== event.partID),
      };
    }
    const parts = message.parts.filter((p) => p.id !== event.part.id);
    parts.push(event.part);
    return { ...message, parts };
  });
}
