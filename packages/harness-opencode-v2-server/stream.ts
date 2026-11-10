// SPDX-License-Identifier: LGPL-3.0-only
import type { DiscoveredService } from "./discovery.ts";
import { serviceHeaders } from "./discovery.ts";
import { V2Client } from "./client.ts";
import { OperationFailure } from "@otk/protocol";

export const V2_SILENCE_MS = 45_000;
export interface V2Event {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  created?: number;
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
}
/** Adapter-owned SSE consumer. No SDK queue, replay fiction or service lifecycle. */
export class V2Stream {
  #lifetime?: AbortController;
  #task?: Promise<void>;
  #stopping?: Promise<void>;
  #ready?: PromiseWithResolvers<void>;
  #client?: V2Client;
  #generation = 0;
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
    const apply = async (event: V2Event) => {
      signal.throwIfAborted();
      if (event.id && seen.has(event.id)) return;
      const aggregate = event.durable?.aggregateID;
      if (
        typeof aggregate === "string" &&
        event.durable!.seq <= (sequences.get(aggregate) ?? -1)
      ) return;
      try {
        await this.ports.event(event, client, signal, generation);
      } catch (error) {
        signal.throwIfAborted();
        // A live fact whose required scalar read failed needs the existing
        // reconnect/resync owner, not a diagnostic-only dropped event.
        if (
          error instanceof OperationFailure && error.outcome === "unavailable"
        ) throw error;
        this.ports.diagnostic(error);
        return;
      }
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
    const accept = async (raw: string) => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        this.ports.diagnostic(error);
        return;
      }
      const event = decodeEvent(value);
      if (!event) {
        this.ports.diagnostic(new Error("Ignored malformed V2 event frame"));
        return;
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
      if (booted) {
        pause();
        try {
          await apply(event);
        } finally {
          touch();
        }
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
      // Closure aborts snapshot reads even while the parser is backpressured.
      void reader.closed.then(
        () => owner.abort(new Error("Opencode V2 stream closed")),
        (error) => owner.abort(error),
      );
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
        const chunk = await reader.read();
        if (chunk.done) break;
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
    } finally {
      owner.abort();
      pause();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await bootstrap?.catch(() => {});
    }
  }
}
