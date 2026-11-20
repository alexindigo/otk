// SPDX-License-Identifier: LGPL-3.0-only
import type { DiscoveredService } from "./discovery.ts";
import { serviceHeaders } from "./discovery.ts";
import { V2Client } from "./client.ts";
import { OperationFailure } from "@otk/protocol";
import type { EventDispatchPressure } from "@otk/harness";

export const V2_SILENCE_MS = 45_000;
export interface V2Event {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  created?: number;
  metadata?: import("./messages.ts").NativeMessage["metadata"];
  location?: { directory: string; [key: string]: unknown };
  durable?: { seq: number; [key: string]: unknown };
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
/** Decode only used fields, retaining execution facts across schema drift. */
export function decodeEvent(value: unknown): V2Event | undefined {
  if (!record(value) || typeof value.type !== "string" || !record(value.data)) {
    return;
  }
  const execution =
    /^session\.execution\.(started|succeeded|failed|interrupted)$/.test(
      value.type,
    ) &&
    typeof value.data.sessionID === "string";
  if (
    (value.id !== undefined && typeof value.id !== "string") ||
    (value.location !== undefined &&
      (!record(value.location) ||
        typeof value.location.directory !== "string")) ||
    (value.created !== undefined &&
      (typeof value.created !== "number" || !Number.isFinite(value.created))) ||
    (value.durable !== undefined &&
      (!record(value.durable) || !Number.isSafeInteger(value.durable.seq) ||
        Number(value.durable.seq) < 0 ||
        typeof value.durable.aggregateID !== "string"))
  ) {
    return execution ? { type: value.type, data: value.data } : undefined;
  }
  return value as unknown as V2Event;
}
export interface StreamPorts {
  admission?(signal: AbortSignal): Promise<() => void>;
  discover(signal: AbortSignal): Promise<DiscoveredService>;
  /** Acquire snapshot without publishing. The returned commit is abort-fenced. */
  resync(
    client: V2Client,
    signal: AbortSignal,
    generation: number,
  ): Promise<() => void | Promise<void>>;
  event(
    event: V2Event,
    client: V2Client,
    signal: AbortSignal,
    generation: number,
  ): void | Promise<void>;
  connected(client: V2Client, generation: number): void;
  disconnected(generation: number): void;
  diagnostic(error: unknown): void;
  dispatch?(pressure: EventDispatchPressure): void;
}
/** Adapter-owned SSE consumer. No SDK queue, replay fiction or service lifecycle. */
export class V2Stream {
  #lifetime?: AbortController;
  #task?: Promise<void>;
  #stopping?: Promise<void>;
  #ready?: PromiseWithResolvers<void>;
  #client?: V2Client;
  #generation = 0;
  #connection?: AbortController;
  #pressure?: () => EventDispatchPressure;
  get pressure(): EventDispatchPressure | undefined {
    return this.#pressure?.();
  }
  /** Background projection failures retire the same generation as handler errors. */
  reconnect(error: unknown): void {
    this.#connection?.abort(error);
  }
  constructor(
    readonly ports: StreamPorts,
    readonly policy: {
      requestms: number;
      reconnectmax: number;
      heartbeattimeout: number;
      replayops: number;
      replaybytes: number;
    },
    readonly fetcher: typeof fetch = fetch,
    readonly admission?: (signal: AbortSignal) => Promise<() => void>,
  ) {}
  get client(): V2Client {
    if (!this.#client) {
      throw new OperationFailure(
        "unavailable",
        "native.unavailable",
        new Error("Opencode V2 is not connected"),
      );
    }
    return this.#client;
  }
  start(): Promise<void> {
    if (this.#lifetime || this.#stopping) {
      return Promise.reject(new Error("Harness is already started"));
    }
    const controller = this.#lifetime = new AbortController();
    const ready = this.#ready = Promise.withResolvers<void>();
    this.#task = this.#loop(controller.signal, ready);
    return ready.promise;
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#lifetime?.abort();
    this.#client = undefined;
    return this.#stopping = (async () => {
      await this.#task;
      this.#lifetime = undefined;
      this.#ready = undefined;
      this.#stopping = undefined;
    })();
  }
  async #loop(
    signal: AbortSignal,
    ready: PromiseWithResolvers<void>,
  ): Promise<void> {
    let delay = 1, admitted = false;
    while (!signal.aborted) {
      const generation = ++this.#generation;
      const owner = new AbortController();
      this.#connection = owner;
      const current = AbortSignal.any([signal, owner.signal]);
      let client: V2Client | undefined;
      try {
        const service = await this.ports.discover(current);
        current.throwIfAborted();
        client = new V2Client(
          service,
          this.policy.requestms,
          current,
          this.fetcher,
          this.ports.admission ?? this.admission,
          undefined,
          signal,
        );
        await this.#consume(client, owner, current, generation, () => {
          this.#client = client;
          this.ports.connected(client!, generation);
          admitted = true;
          delay = 1;
          ready.resolve();
        });
        throw new Error("Opencode V2 event stream closed");
      } catch (error) {
        owner.abort(error);
        if (!admitted) {
          ready.reject(error);
          return;
        }
        if (!signal.aborted) this.ports.diagnostic(error);
      } finally {
        owner.abort();
        if (this.#connection === owner) this.#connection = undefined;
        this.#client = undefined;
        this.ports.disconnected(generation);
        await client?.join();
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, delay * 1000);
          signal.addEventListener("abort", done, { once: true });
        });
        delay = Math.min(this.policy.reconnectmax, delay * 2);
      }
    }
    ready.reject(signal.reason);
  }
  async #consume(
    client: V2Client,
    owner: AbortController,
    signal: AbortSignal,
    generation: number,
    ready: () => void,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = () => clearTimeout(timer);
    const touch = () => {
      pause();
      // V2 has 15-second comment heartbeats. The one existing policy leaf is
      // raised to its protocol minimum, not replaced by a second operator knob.
      timer = setTimeout(
        () =>
          owner.abort(new Error("Opencode V2 stream silent for 45 seconds")),
        Math.max(V2_SILENCE_MS, this.policy.heartbeattimeout * 1000),
      );
    };
    let bootstrap: Promise<void> | undefined, booted = false;
    const queue: V2Event[] = [];
    let queuedBytes = 0;
    const seen = new Set<string>();
    const sequences = new Map<string, number>();
    const backlog = new Map<
      number,
      { event: V2Event; bytes: number; at: number }
    >();
    let next = 0, backlogBytes = 0, received = 0, handled = 0;
    let active: { event: V2Event; at: number; started: number } | undefined;
    let admitting: { bytes: number; at: number } | undefined;
    let nativeLagMs = 0,
      maxNativeLagMs = 0,
      handlerMs = 0,
      backpressured = false;
    let dispatch: Promise<void> | undefined;
    const capacity = new Set<() => void>();
    const pressure = () => ({
      generation,
      received,
      handled,
      queued: queue.length + backlog.size + (admitting ? 1 : 0),
      queuedBytes: queuedBytes + backlogBytes + (admitting?.bytes ?? 0),
      oldestAgeMs: active
        ? Date.now() - active.at
        : backlog.size
        ? Date.now() - backlog.values().next().value!.at
        : 0,
      nativeLagMs: active?.event.created === undefined
        ? nativeLagMs
        : Math.max(0, Date.now() - active.event.created),
      maxNativeLagMs,
      handlerMs: active ? performance.now() - active.started : handlerMs,
      activeType: active?.event.type,
      backpressured,
    });
    this.#pressure = pressure;
    const report = () => this.ports.dispatch?.(pressure());
    const reporting = this.ports.dispatch
      ? setInterval(report, 1000)
      : undefined;
    const process = async (event: V2Event) => {
      signal.throwIfAborted();
      if (event.id && seen.has(event.id)) return;
      const aggregate = event.durable?.aggregateID;
      if (
        typeof aggregate === "string" &&
        event.durable!.seq <= (sequences.get(aggregate) ?? -1)
      ) return;
      // Any failed projection needs canonical resync. Logging and continuing
      // would leave a permanently absent fact under an apparently healthy clock.
      await this.ports.event(event, client, signal, generation);
      signal.throwIfAborted();
      if (typeof aggregate === "string") {
        sequences.set(aggregate, event.durable!.seq);
        if (sequences.size > 4096) {
          sequences.delete(sequences.keys().next().value!);
        }
      }
      if (event.id) {
        seen.add(event.id);
        // Bounded dedupe window, not an unbounded event history.
        if (seen.size > 4096) seen.delete(seen.values().next().value!);
      }
    };
    const apply = async (event: V2Event, at = Date.now()) => {
      const started = performance.now();
      active = { event, at, started };
      if (event.created !== undefined) {
        nativeLagMs = Math.max(0, Date.now() - event.created);
        maxNativeLagMs = Math.max(maxNativeLagMs, nativeLagMs);
      }
      try {
        await process(event);
        handled++;
      } finally {
        handlerMs = performance.now() - started;
        active = undefined;
      }
    };
    const kick = () => {
      if (dispatch) return;
      dispatch = (async () => {
        while (backlog.size) {
          signal.throwIfAborted();
          const [key, work] = backlog.entries().next().value!;
          backlog.delete(key);
          backlogBytes -= work.bytes;
          for (const wake of capacity) wake();
          capacity.clear();
          await apply(work.event, work.at);
        }
      })().catch((error) => owner.abort(error)).finally(() => {
        dispatch = undefined;
        for (const wake of capacity) wake();
        capacity.clear();
        if (!signal.aborted && backlog.size) kick();
      });
    };
    const enqueue = async (event: V2Event) => {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      const at = Date.now();
      admitting = { bytes, at };
      while (
        backlog.size >= this.policy.replayops ||
        (backlog.size > 0 && backlogBytes + bytes > this.policy.replaybytes)
      ) {
        backpressured = true;
        pause();
        try {
          await new Promise<void>((resolve) => {
            const done = () => {
              capacity.delete(done);
              signal.removeEventListener("abort", done);
              resolve();
            };
            capacity.add(done);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
          signal.throwIfAborted();
        } finally {
          backpressured = false;
          touch();
        }
      }
      backlog.set(++next, { event, bytes, at });
      admitting = undefined;
      backlogBytes += bytes;
      kick();
    };
    const accept = async (raw: string) => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new Error("Malformed V2 event JSON requires resync", {
          cause: error,
        });
      }
      const event = decodeEvent(value);
      if (!event) {
        throw new Error("Malformed V2 event frame requires resync");
      }
      if (event.type === "server.connected") {
        if (bootstrap) return;
        // The actual stream is iterated before any snapshot read or effect.
        bootstrap = (async () => {
          const commit = await this.ports.resync(client, signal, generation);
          signal.throwIfAborted();
          await commit();
          while (queue.length) {
            const pending = queue.shift()!;
            queuedBytes -=
              new TextEncoder().encode(JSON.stringify(pending)).byteLength;
            await apply(pending);
          }
          signal.throwIfAborted();
          booted = true;
          ready();
        })();
        void bootstrap.catch((error) => owner.abort(error));
        return;
      }
      if (!bootstrap) return;
      received++;
      if (booted) {
        await enqueue(event);
        return;
      }
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (
        queue.length >= this.policy.replayops ||
        queuedBytes + size > this.policy.replaybytes
      ) {
        pause();
        try {
          await bootstrap;
          await apply(event);
        } finally {
          touch();
        }
      } else {
        queue.push(event);
        queuedBytes += size;
      }
    };
    touch();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let nextRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let cancelReader: (() => Promise<void>) | undefined;
    const cancelBody = () => {
      void cancelReader?.();
    };
    try {
      const response = await this.fetcher(
        new URL("/api/event", client.service.endpoint.url),
        {
          headers: {
            ...serviceHeaders(client.service.endpoint),
            accept: "text/event-stream",
          },
          signal,
        },
      );
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error(
          response.status === 401
            ? "Opencode authentication failed (401)."
            : "Opencode V2 event stream unavailable",
        );
      }
      reader = response.body.getReader();
      const ownedReader = reader;
      let cancellation: Promise<void> | undefined;
      cancelReader = () =>
        cancellation ??= ownedReader.cancel().catch(() => {});
      // Transport abort does not necessarily retire an acquired body read.
      // Cancel the body at its owner and join that same cleanup in finally.
      signal.addEventListener("abort", cancelBody, { once: true });
      if (signal.aborted) cancelBody();
      // Closure aborts snapshot reads even while the parser is backpressured.
      void reader.closed.then(
        () => owner.abort(new Error("Opencode V2 stream closed")),
        (error) => owner.abort(error),
      );
      // One transport read can observe EOF/failure while ordered event work is
      // backpressured. Never drain another chunk until the parser consumes this
      // one; bootstrap event/byte admission remains at accept().
      const readAhead = () => {
        const pending = ownedReader.read();
        void pending.then(
          (chunk) => {
            if (chunk.done) owner.abort(new Error("Opencode V2 stream closed"));
          },
          (error) => owner.abort(error),
        );
        return pending;
      };
      nextRead = readAhead();
      const decoder = new TextDecoder();
      let fragments: string[] = [], data: string[] = [], skipLF = false;
      const line = async (text: string) => {
        if (!text) {
          if (data.length) {
            const raw = data.join("\n");
            data = [];
            await accept(raw);
          }
        } else if (text.startsWith("data:")) {
          data.push(text.slice(5).replace(/^ /, ""));
        }
      };
      while (true) {
        const chunk = await nextRead;
        if (chunk.done) break;
        nextRead = readAhead();
        touch(); // Includes comments, including split UTF-8/CRLF frames.
        const text = decoder.decode(chunk.value, { stream: true });
        let start = skipLF && text[0] === "\n" ? 1 : 0;
        skipLF = false;
        for (let i = start; i < text.length; i++) {
          if (text[i] !== "\r" && text[i] !== "\n") continue;
          fragments.push(text.slice(start, i));
          const complete = fragments.join("");
          fragments = [];
          await line(complete);
          if (text[i] === "\r") {
            if (text[i + 1] === "\n") i++;
            else if (i === text.length - 1) skipLF = true;
          }
          start = i + 1;
        }
        if (start < text.length) fragments.push(text.slice(start));
      }
      signal.throwIfAborted();
    } finally {
      owner.abort();
      pause();
      clearInterval(reporting);
      signal.removeEventListener("abort", cancelBody);
      await cancelReader?.();
      await nextRead?.catch(() => {});
      reader?.releaseLock();
      await bootstrap?.catch(() => {});
      await dispatch;
      backlog.clear();
      backlogBytes = 0;
      report();
      if (this.#pressure === pressure) this.#pressure = undefined;
    }
  }
}
