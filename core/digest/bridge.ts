// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DigestPolicy,
  DigestPort,
  DigestPublication,
  DirtySession,
} from "@otk/harness";
import type { SessionMetadata, SessionUsage } from "@otk/protocol";
import type { OpencodeV1Config } from "@otk/harness-opencode-v1";
import type { DigestPressure, FromWorker, ToWorker } from "./protocol.ts";
import type { SectionObserver } from "../diagnostics.ts";

export interface DigestBridgeOptions {
  statePath: string;
  provider: string;
  native: OpencodeV1Config;
  policy: DigestPolicy;
  publish(value: DigestPublication): void;
  diagnostic?(error: Error): void;
  unready?(sessionIDs: readonly string[]): void;
  metadata?(entries: readonly SessionMetadata[]): void;
  section?: SectionObserver;
  pressure?(value: DigestPressure): void;
  admission?(): void;
}
interface Pending {
  receive(value: FromWorker): void;
  reject(error: unknown): void;
}
interface Shared {
  controller: AbortController;
  promise: Promise<unknown>;
  users: number;
}
interface QueuedDirty extends DirtySession {
  reasons: Set<DirtySession["reason"]>;
}
interface QueuedDeletion {
  connection: number;
  sessionID: string;
  revision: number;
  metadata?: SessionMetadata;
  done: PromiseWithResolvers<void>;
}
type Command = ToWorker extends infer T
  ? T extends ToWorker ? Omit<T, "run" | "id"> : never
  : never;
/** Serving-isolate transport only. All native and derived SQLite stays in the worker. */
export class DigestBridge implements DigestPort {
  #worker?: Worker;
  #run = "";
  #id = 0;
  #pending = new Map<number, Pending>();
  #shared = new Map<string, Shared>();
  #sequences = new Map<
    string,
    { revision: number; part: number; last: boolean }
  >();
  #start?: Promise<void>;
  #stop?: Promise<void>;
  #dirty = new Map<string, QueuedDirty>();
  #dirtyScheduled = false;
  #dirtyInFlight = false;
  #fineKeys = 0;
  #connection = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #retry?: ReturnType<typeof setTimeout>;
  #scopes = new Map<string, { directory?: string; sessions: string[] }>();
  #interactive = new Set<string>();
  #running = false;
  #deletions = new Map<string, QueuedDeletion>();
  #deleting = new Map<string, QueuedDeletion>();
  #deletionScheduled = false;
  #intents = new Map<
    string,
    { intent: string; connection: number; phase: "begin" | "confirmed" }
  >();
  #reconcile = false;
  #reconcileScheduled = false;
  constructor(readonly options: DigestBridgeOptions) {}
  get publishrows(): number {
    return this.options.policy.publishrows;
  }
  #post(command: Command): number {
    if (!this.#worker) throw new Error("Digest worker is unavailable");
    const id = ++this.#id;
    this.#worker.postMessage(
      { ...command, run: this.#run, id } satisfies ToWorker,
    );
    return id;
  }
  #task(run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, 0);
    this.#timers.add(timer);
  }
  #fail(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.options.diagnostic?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  #retire(worker: Worker, error: Error): void {
    if (worker !== this.#worker) return;
    const identities = [...this.#sequences.keys()];
    this.#sequences.clear();
    worker.terminate();
    this.#worker = undefined;
    this.#running = false;
    this.#start = undefined;
    this.#fail(error);
    this.options.unready?.(identities);
    for (const shared of this.#shared.values()) shared.controller.abort(error);
    this.#shared.clear();
    if (this.#stop || this.#retry || this.#worker) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (this.#stop) return;
      const opening = this.#start = this.#open();
      void opening.catch((error) => {
        const owner = this.#worker;
        if (owner) {
          this.#retire(
            owner,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    }, this.options.policy.retryms);
  }
  start(): Promise<void> {
    if (this.#stop) {
      return Promise.reject(new Error("Digest bridge is stopped"));
    }
    clearTimeout(this.#retry);
    this.#retry = undefined;
    return this.#start ??= this.#open();
  }
  #open(): Promise<void> {
    this.options.admission?.();
    this.#run = crypto.randomUUID();
    const worker = this.#worker = new Worker(
      new URL("./worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (worker !== this.#worker || data.run !== this.#run) return;
      const start = performance.now();
      if (data.t === "digest") {
        const previous = this.#sequences.get(data.sessionID);
        const valid = !previous || data.revision > previous.revision
          ? data.part === 0
          : data.revision === previous.revision && !previous.last &&
            data.part === previous.part + 1;
        if (valid) {
          this.#sequences.set(data.sessionID, {
            revision: data.revision,
            part: data.part,
            last: data.last,
          });
          this.options.publish({
            sessionID: data.sessionID,
            revision: data.revision,
            delta: data.delta,
          });
          if (data.delta.deleted?.how === "otk") {
            this.#intents.delete(data.sessionID);
          }
        }
      } else if (data.t === "pressure") {
        this.options.pressure?.(data);
      } else if (data.t === "error") {
        const error = new Error(data.message, {
          cause: { scope: data.scope, sessionID: data.sessionID },
        });
        const pending = this.#pending.get(data.id);
        if (pending) {
          this.#pending.delete(data.id);
          pending.reject(error);
        } else this.options.diagnostic?.(error);
      } else if (data.t === "catalog" && data.id === 0) {
        this.options.metadata?.(data.entries);
      } else this.#pending.get(data.id)?.receive(data);
      if (data.t === "digest" || data.t === "catalog" || data.t === "detail") {
        this.#task(() => {
          if (worker === this.#worker) {
            this.#post({ t: "credit", publications: 1 });
          }
        });
      }
      this.options.section?.(`worker:${data.t}`, performance.now() - start);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#retire(worker, new Error(event.message || "Digest worker failed"));
    };
    const gate = Promise.withResolvers<void>();
    const id = this.#post({
      t: "start",
      provider: this.options.provider,
      statePath: this.options.statePath,
      native: this.options.native,
      policy: this.options.policy,
      since: Date.now(),
      connection: this.#connection,
      diagnostics: !!this.options.pressure,
    });
    this.#pending.set(id, {
      receive: (value) => {
        if (value.t === "accepted") {
          this.#pending.delete(id);
          void (async () => {
            for (const [owner, value] of this.#scopes) {
              this.#post({ t: "scope", owner, ...value });
            }
            for (const owner of this.#interactive) {
              this.#post({ t: "interactive", owner, active: true });
            }
            for (const [sessionID, value] of this.#intents) {
              if (value.connection !== this.#connection) continue;
              for (
                const phase of value.phase === "confirmed"
                  ? ["begin", "confirmed"] as const
                  : ["begin"] as const
              ) {
                await this.#request(
                  {
                    t: "deleteIntent",
                    sessionID,
                    intent: value.intent,
                    phase,
                    connection: value.connection,
                  },
                  new AbortController().signal,
                  (message) =>
                    message.t === "accepted" ? { value: undefined } : undefined,
                );
              }
            }
            this.#running = true;
            this.#reconcile = this.#connection > 0;
            gate.resolve();
            this.#scheduleDeleted();
            this.#maybeReconcile();
          })().catch(gate.reject);
        }
      },
      reject: gate.reject,
    });
    return gate.promise;
  }
  async #lease<T>(
    key: string,
    signal: AbortSignal,
    create: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    let shared = this.#shared.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = { controller, promise: create(controller.signal), users: 0 };
      this.#shared.set(key, shared);
      const owner = shared;
      void shared.promise.finally(() => {
        if (this.#shared.get(key) === owner) this.#shared.delete(key);
      }).catch(() => {});
    }
    const owner = shared;
    owner.users++;
    const gate = Promise.withResolvers<T>();
    const abort = () => gate.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void owner.promise.then((value) => gate.resolve(value as T), gate.reject);
    try {
      return await gate.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      if (--owner.users === 0) {
        if (this.#shared.get(key) === owner) this.#shared.delete(key);
        owner.controller.abort(
          new DOMException("Digest read released", "AbortError"),
        );
      }
    }
  }
  #request<T>(
    command: Command,
    signal: AbortSignal,
    reduce: (value: FromWorker) => { value: T } | undefined,
  ): Promise<T> {
    signal.throwIfAborted();
    const gate = Promise.withResolvers<T>();
    const id = this.#post(command);
    const abort = () => {
      if (this.#pending.delete(id)) {
        this.#post({ t: "cancel", request: id });
        gate.reject(signal.reason);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    this.#pending.set(id, {
      receive: (message) => {
        try {
          const result = reduce(message);
          if (result) {
            this.#pending.delete(id);
            gate.resolve(result.value);
          }
        } catch (error) {
          this.#pending.delete(id);
          this.#post({ t: "cancel", request: id });
          gate.reject(error);
        }
      },
      reject: gate.reject,
    });
    return gate.promise.finally(() =>
      signal.removeEventListener("abort", abort)
    );
  }
  async catalog(
    connection: number,
    signal: AbortSignal,
  ): Promise<
    { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
  > {
    await this.start();
    if (connection > this.#connection) {
      this.#dirty.clear();
      this.#fineKeys = 0;
    }
    this.#connection = Math.max(this.#connection, connection);
    this.#reconcile = false;
    for (const [id, value] of this.#intents) {
      if (value.connection !== this.#connection) this.#intents.delete(id);
    }
    for (const [id, value] of this.#deletions) {
      if (value.connection !== this.#connection) {
        this.#deletions.delete(id);
        value.done.resolve();
      }
    }
    this.#scheduleDirty();
    return await this.#lease(`catalog:${connection}`, signal, (owned) => {
      const entries: SessionMetadata[] = [], hints: string[] = [];
      let part = 0, hasHints = false;
      return this.#request({ t: "catalog", connection }, owned, (message) => {
        if (message.t !== "catalog") return;
        if (message.connection !== connection || message.part !== part++) {
          throw new Error("Out-of-order digest catalog");
        }
        this.options.metadata?.(message.entries);
        entries.push(...message.entries);
        if (message.hints) {
          hasHints = true;
          hints.push(...message.hints);
        }
        if (message.last) {
          return {
            value: {
              entries,
              authoritative: message.authoritative,
              ...(hasHints ? { hints } : {}),
            },
          };
        }
      });
    });
  }
  async detail(sessionID: string, signal: AbortSignal): Promise<SessionUsage> {
    await this.start();
    return await this.#lease(`detail:${sessionID}`, signal, (owned) => {
      const detail: SessionUsage = {
        sessionID,
        total: {
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
          models: [],
        },
        turns: {},
        messages: [],
      };
      let part = 0, total = false;
      return this.#request({ t: "detail", sessionID }, owned, (message) => {
        if (message.t !== "detail") return;
        if (message.sessionID !== sessionID || message.part !== part++) {
          throw new Error("Out-of-order digest detail");
        }
        if (message.total) {
          detail.total = message.total;
          total = true;
        }
        Object.assign(detail.turns, message.turns);
        detail.messages.push(...message.messages);
        if (message.last) {
          if (!total) throw new Error("Missing digest detail total");
          return { value: detail };
        }
      });
    });
  }
  async transcriptMetadata(
    sessionID: string,
    turns: readonly string[],
    signal: AbortSignal,
    cutoff?: string,
  ): Promise<import("@otk/harness").TranscriptMetadata> {
    await this.start();
    return await this.#lease(
      `transcript:${JSON.stringify([sessionID, turns, cutoff])}`,
      signal,
      (owned) =>
        this.#request(
          { t: "transcript", sessionID, turns: [...turns], cutoff },
          owned,
          (message) => {
            if (message.t !== "transcript") return;
            if (message.sessionID !== sessionID) {
              throw new Error("Transcript metadata identity mismatch");
            }
            return { value: message.metadata };
          },
        ),
    );
  }
  deleted(
    connection: number,
    sessionID: string,
    revision: number,
    metadata?: SessionMetadata,
  ): Promise<void> {
    if (this.#stop || connection !== this.#connection) return Promise.resolve();
    if (metadata && metadata.id !== sessionID) {
      return Promise.reject(new Error("Deletion metadata identity mismatch"));
    }
    const retained = metadata && structuredClone(metadata);
    const queued = this.#deletions.get(sessionID);
    if (queued) {
      if (retained && revision >= queued.revision) queued.metadata = retained;
      queued.revision = Math.max(queued.revision, revision);
      return queued.done.promise;
    }
    const inflight = this.#deleting.get(sessionID);
    if (
      inflight && inflight.revision >= revision &&
      (!retained || inflight.metadata)
    ) return inflight.done.promise;
    const value: QueuedDeletion = {
      connection,
      sessionID,
      revision,
      ...(retained ? { metadata: retained } : {}),
      done: Promise.withResolvers<void>(),
    };
    this.#deletions.set(sessionID, value);
    this.#scheduleDeleted();
    return value.done.promise;
  }
  #scheduleDeleted(): void {
    if (
      !this.#running || this.#stop || this.#deletionScheduled ||
      this.#deleting.size || !this.#deletions.size
    ) return;
    this.#deletionScheduled = true;
    this.#task(() => {
      this.#deletionScheduled = false;
      if (!this.#running || this.#stop || this.#deleting.size) return;
      const connection = this.#connection;
      const batch = [...this.#deletions.values()].slice(
        0,
        Math.min(this.options.policy.batch, this.options.policy.maxpending),
      );
      if (!batch.length) return;
      for (const value of batch) {
        this.#deletions.delete(value.sessionID);
        this.#deleting.set(value.sessionID, value);
      }
      const worker = this.#worker;
      void this.#request(
        {
          t: "deleted",
          connection,
          sessions: batch.map(({ sessionID, revision, metadata }) => ({
            sessionID,
            revision,
            ...(metadata ? { metadata } : {}),
          })),
        },
        new AbortController().signal,
        (message) =>
          message.t === "accepted" ? { value: undefined } : undefined,
      ).then(() => {
        for (const value of batch) {
          this.#deleting.delete(value.sessionID);
          value.done.resolve();
        }
        this.#scheduleDeleted();
        this.#maybeReconcile();
      }, (error) => {
        for (const value of batch) {
          this.#deleting.delete(value.sessionID);
          if (this.#stop) value.done.reject(error);
          else if (connection !== this.#connection) value.done.resolve();
          else {
            const next = this.#deletions.get(value.sessionID);
            if (next) {
              next.metadata ??= value.metadata;
              next.revision = Math.max(next.revision, value.revision);
              void next.done.promise.then(
                value.done.resolve,
                value.done.reject,
              );
            } else this.#deletions.set(value.sessionID, value);
          }
        }
        if (worker && worker === this.#worker && !this.#stop) {
          this.#retire(
            worker,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    });
  }
  #maybeReconcile(): void {
    if (
      !this.#reconcile || this.#reconcileScheduled || !this.#running ||
      this.#deletions.size || this.#deleting.size || this.#stop
    ) return;
    this.#reconcileScheduled = true;
    this.#task(() => {
      this.#reconcileScheduled = false;
      if (
        !this.#reconcile || !this.#running || this.#deletions.size ||
        this.#deleting.size || this.#stop
      ) return;
      this.#reconcile = false;
      const worker = this.#worker;
      void this.catalog(this.#connection, new AbortController().signal).catch(
        (error) => {
          if (worker && worker === this.#worker && !this.#stop) {
            this.#retire(
              worker,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        },
      );
    });
  }
  observe(connection: number, dirty: readonly DirtySession[]): void {
    if (this.#stop || connection !== this.#connection) return;
    for (const item of dirty) {
      const old = this.#dirty.get(item.sessionID);
      const messages = item.reason === "attention"
        ? old?.messages
        : old && ![...old.reasons].every((reason) => reason === "attention")
        ? old.messages && item.messages
          ? [...new Set([...old.messages, ...item.messages])]
          : undefined
        : item.messages && [...new Set(item.messages)];
      const retained =
        messages && messages.length <= this.options.policy.maxpending
          ? messages
          : undefined;
      this.#fineKeys += (retained?.length ?? 0) - (old?.messages?.length ?? 0);
      this.#dirty.set(item.sessionID, {
        ...item,
        revision: Math.max(old?.revision ?? 0, item.revision),
        messages: retained,
        reasons: new Set([...(old?.reasons ?? []), item.reason]),
      });
      if (this.#fineKeys > this.options.policy.maxpending) {
        for (const pending of this.#dirty.values()) delete pending.messages;
        this.#fineKeys = 0;
      }
    }
    this.#scheduleDirty();
  }
  attention(sessionID: string): void {
    this.observe(this.#connection, [{
      sessionID,
      revision: 0,
      reason: "attention",
    }]);
  }
  #scheduleDirty(): void {
    if (
      this.#worker && !this.#stop && this.#dirty.size &&
      !this.#dirtyScheduled && !this.#dirtyInFlight
    ) {
      this.#dirtyScheduled = true;
      this.#task(() => {
        this.#dirtyScheduled = false;
        if (!this.#worker || this.#stop || this.#dirtyInFlight) return;
        const connection = this.#connection;
        const queued = [...this.#dirty.values()].slice(
          0,
          Math.min(this.options.policy.batch, this.options.policy.maxpending),
        );
        const sessions: DirtySession[] = [];
        for (const pending of queued) {
          this.#dirty.delete(pending.sessionID);
          this.#fineKeys -= pending.messages?.length ?? 0;
          for (const reason of pending.reasons) {
            sessions.push({
              sessionID: pending.sessionID,
              revision: pending.revision,
              reason,
              messages: pending.messages,
            });
          }
        }
        this.#dirtyInFlight = true;
        void this.#request(
          { t: "dirty", connection, sessions },
          new AbortController().signal,
          (message) =>
            message.t === "accepted" ? { value: undefined } : undefined,
        ).then(() => {
          this.#dirtyInFlight = false;
          this.#scheduleDirty();
        }, () => {
          this.#dirtyInFlight = false;
          // A failed generation may lose an acknowledgement, never an invalidation.
          // Reconciliation markers are sufficient; do not retain message payloads.
          if (!this.#stop && connection === this.#connection) {
            this.observe(
              connection,
              sessions.map((item) => ({ ...item, messages: undefined })),
            );
          }
        });
      });
    }
  }
  async deleteIntent(
    sessionID: string,
    intent: string,
    phase: "begin" | "confirmed" | "failed",
    connection: number,
  ): Promise<void> {
    if (connection !== this.#connection || this.#stop) return;
    if (phase === "begin") {
      this.#intents.set(sessionID, { intent, connection, phase });
    } else if (this.#intents.get(sessionID)?.intent === intent) {
      if (phase === "failed") this.#intents.delete(sessionID);
      else this.#intents.set(sessionID, { intent, connection, phase });
    }
    await this.start();
    await this.#request(
      { t: "deleteIntent", sessionID, intent, phase, connection },
      new AbortController().signal,
      (message) => message.t === "accepted" ? { value: undefined } : undefined,
    );
  }
  scope(
    owner: string,
    value: { directory?: string; sessions: string[] },
  ): void {
    if (this.#stop) return;
    this.#scopes.set(owner, structuredClone(value));
    if (this.#worker) this.#post({ t: "scope", owner, ...value });
  }
  release(owner: string): void {
    this.#scopes.delete(owner);
    this.#interactive.delete(owner);
    if (this.#worker && !this.#stop) {
      this.#post({ t: "scope", owner, sessions: [] });
      this.#post({ t: "interactive", owner, active: false });
    }
  }
  interactive(owner: string, active: boolean): void {
    if (this.#stop) return;
    if (active) this.#interactive.add(owner);
    else this.#interactive.delete(owner);
    if (this.#worker) this.#post({ t: "interactive", owner, active });
  }
  stop(): Promise<void> {
    return this.#stop ??= this.#close();
  }
  async #close(): Promise<void> {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#running = false;
    const released = new DOMException("Digest bridge stopped", "AbortError");
    for (
      const value of [...this.#deletions.values(), ...this.#deleting.values()]
    ) value.done.reject(released);
    this.#deletions.clear();
    this.#deleting.clear();
    this.#intents.clear();
    if (!this.#worker) return;
    for (const shared of this.#shared.values()) {
      shared.controller.abort(
        new DOMException("Digest bridge stopped", "AbortError"),
      );
    }
    this.#shared.clear();
    const worker = this.#worker;
    const gate = Promise.withResolvers<void>();
    const id = this.#post({ t: "stop" });
    this.#pending.set(id, {
      receive: (message) => {
        if (message.t === "stopped") {
          this.#pending.delete(id);
          gate.resolve();
        }
      },
      reject: gate.reject,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gate.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Digest worker shutdown timed out")),
            this.options.policy.retryms + this.options.policy.busyms + 5000,
          );
        }),
      ]);
    } catch (error) {
      this.options.diagnostic?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      worker.terminate();
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#worker = undefined;
      this.#running = false;
      for (const timer of this.#timers) clearTimeout(timer);
      this.#timers.clear();
      this.#fail(new DOMException("Digest bridge stopped", "AbortError"));
      this.#dirty.clear();
      this.#fineKeys = 0;
      this.#sequences.clear();
      this.#scopes.clear();
      this.#interactive.clear();
    }
  }
}
