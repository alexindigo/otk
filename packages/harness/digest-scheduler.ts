// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DigestIdentity,
  DigestJob,
  DigestPolicy,
  DigestPriority,
  DigestSink,
  DirtySession,
} from "./digest.ts";
const rank: Record<DigestPriority, number> = {
  interactive: 0,
  attention: 1,
  visible: 2,
  background: 3,
};
interface Pending {
  job: DigestJob;
  priority: DigestPriority;
  order: number;
  changed: boolean;
}
/** One cooperative executor. Sinks own durable cursors; this owns admission only. */
export class DigestScheduler {
  #sinks = new Map<string, DigestSink>();
  #pending = new Map<string, Pending>();
  #scopes = new Map<string, { directory?: string; sessions: string[] }>();
  #visibleSessions = new Set<string>();
  #visibleDirectories = new Set<string>();
  #interactive = new Set<string>();
  #controller = new AbortController();
  #executing?: Promise<boolean>;
  #order = 0;
  #stopping?: Promise<void>;
  #requests = new Set<{ run(): Promise<void>; cancel(): void }>();
  #dutyUntil = 0;
  #dutyWait?: AbortController;
  #slice?: AbortController;
  constructor(
    readonly policy: DigestPolicy,
    readonly resources: {
      freeMemory(): number;
      sleep(ms: number, signal: AbortSignal): Promise<void>;
      now?: () => number;
    },
  ) {}
  register(sink: DigestSink): void {
    if (this.#controller.signal.aborted || this.#sinks.has(sink.identity)) {
      throw new Error("Duplicate or stopped digest sink");
    }
    this.#sinks.set(sink.identity, sink);
  }
  #key(job: DigestIdentity): string {
    return JSON.stringify([job.provider, job.sessionID, job.projection]);
  }
  enqueue(
    identity: DigestIdentity,
    priority: DigestPriority,
    dirty?: DirtySession,
  ): void {
    if (this.#controller.signal.aborted) return;
    if (!this.#sinks.has(identity.provider)) {
      throw new Error("Unknown digest sink");
    }
    const key = this.#key(identity);
    const pending = this.#pending.get(key);
    if (pending) {
      if (rank[priority] < rank[pending.priority]) pending.priority = priority;
      pending.job.updated = Math.max(pending.job.updated, identity.updated);
      pending.job.revision = Math.max(
        pending.job.revision,
        dirty?.revision ?? 0,
      );
      // Full-session invalidation dominates fine-grained keys.
      pending.job.messages = pending.job.messages && dirty?.messages
        ? [...new Set([...pending.job.messages, ...dirty.messages])]
        : undefined;
      if ((pending.job.messages?.length ?? 0) > this.policy.maxpending) {
        pending.job.messages = undefined;
      }
      pending.changed = true;
    } else {this.#pending.set(key, {
        job: {
          ...identity,
          revision: dirty?.revision ?? 0,
          messages: dirty?.messages?.length &&
              dirty.messages.length <= this.policy.maxpending
            ? [...new Set(dirty.messages)]
            : undefined,
        },
        priority,
        order: this.#order++,
        changed: false,
      });}
  }
  /** Priority-only demand must not widen a queued targeted read to a full scan. */
  promote(identity: DigestIdentity, priority: DigestPriority): boolean {
    const pending = this.#pending.get(this.#key(identity));
    if (!pending) return false;
    if (rank[priority] < rank[pending.priority]) pending.priority = priority;
    return true;
  }
  setScope(
    owner: string,
    scope: { directory?: string; sessions: string[] },
  ): void {
    if (!this.#controller.signal.aborted) {
      this.#scopes.set(owner, structuredClone(scope));
      this.#visibility();
    }
  }
  #visibility(): void {
    this.#visibleSessions.clear();
    this.#visibleDirectories.clear();
    for (const scope of this.#scopes.values()) {
      for (const id of scope.sessions) this.#visibleSessions.add(id);
      if (scope.directory !== undefined) {
        this.#visibleDirectories.add(scope.directory);
      }
    }
  }
  release(owner: string): void {
    this.#scopes.delete(owner);
    this.#interactive.delete(owner);
    this.#visibility();
  }
  interactive(owner: string, active: boolean): void {
    if (active && !this.#controller.signal.aborted) {
      this.#interactive.add(owner);
    } else this.#interactive.delete(owner);
  }
  get queued(): number {
    return this.#pending.size;
  }
  /** Interactive reads share the same single executing slot as digest slices. */
  execute<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted || this.#controller.signal.aborted) {
      return Promise.reject(signal.reason ?? this.#controller.signal.reason);
    }
    const gate = Promise.withResolvers<T>();
    const combined = AbortSignal.any([signal, this.#controller.signal]);
    const request = {
      run: async () => {
        combined.removeEventListener("abort", cancel);
        try {
          combined.throwIfAborted();
          gate.resolve(await run(combined));
        } catch (error) {
          gate.reject(error);
        }
      },
      cancel: () => {
        this.#requests.delete(request);
        gate.reject(combined.reason);
      },
    };
    const cancel = request.cancel;
    combined.addEventListener("abort", cancel, { once: true });
    this.#requests.add(request);
    this.#slice?.abort(
      new DOMException("Interactive digest demand", "AbortError"),
    );
    this.#dutyWait?.abort(
      new DOMException("Interactive digest demand", "AbortError"),
    );
    return gate.promise;
  }
  /** A quota wait is preemptible admission, never ownership of essential work. */
  async #waitDuty(signal: AbortSignal, yieldSlice = false): Promise<void> {
    const now = this.resources.now ?? (() => performance.now());
    const remaining = Math.max(0, this.#dutyUntil - now());
    if (!remaining && !yieldSlice) {
      this.#dutyUntil = 0;
      return;
    }
    const controller = this.#dutyWait = new AbortController();
    try {
      await this.resources.sleep(
        remaining,
        AbortSignal.any([signal, controller.signal]),
      );
      this.#dutyUntil = 0;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      signal.throwIfAborted();
    } finally {
      if (this.#dutyWait === controller) this.#dutyWait = undefined;
    }
  }
  #priority(pending: Pending): number {
    let priority = rank[pending.priority];
    if (
      priority > rank.visible &&
      (this.#visibleSessions.has(pending.job.sessionID) ||
        pending.job.directory !== undefined &&
          this.#visibleDirectories.has(pending.job.directory))
    ) priority = rank.visible;
    return priority;
  }
  /** One slice; tests and worker composition share this exact executor. */
  tick(): Promise<boolean> {
    return this.#executing ??= this.#tick().finally(() => {
      this.#executing = undefined;
    });
  }
  async #tick(): Promise<boolean> {
    const signal = this.#controller.signal;
    if (signal.aborted) return false;
    const request = this.#requests.values().next().value;
    if (request) {
      this.#requests.delete(request);
      await request.run();
      return true;
    }
    if (this.#dutyUntil) {
      await this.#waitDuty(signal);
      if (this.#requests.size || this.#dutyUntil) return true;
    }
    const now = this.resources.now ?? (() => performance.now());
    const start = now();
    let next: Pending | undefined;
    for (const pending of this.#pending.values()) {
      if (
        !next || this.#priority(pending) < this.#priority(next) ||
        this.#priority(pending) === this.#priority(next) &&
          (pending.job.updated > next.job.updated ||
            pending.job.updated === next.job.updated &&
              pending.order < next.order)
      ) next = pending;
    }
    if (
      !next ||
      (this.#priority(next) !== 0 &&
        (this.#interactive.size ||
          this.resources.freeMemory() < this.policy.memoryreserve))
    ) return false;
    next.changed = false;
    const slice = next.job.interruptible !== false
      ? new AbortController()
      : undefined;
    this.#slice = slice;
    let cursor: string | undefined;
    try {
      cursor = await this.#sinks.get(next.job.provider)!.step(
        structuredClone(next.job),
        { rows: this.policy.batch, until: start + this.policy.slicems },
        slice ? AbortSignal.any([signal, slice.signal]) : signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (slice?.signal.aborted) return true;
      throw error;
    } finally {
      this.#slice = undefined;
    }
    if (next.changed) {
      // A raced invalidation must be reconciled after the current committed slice.
      if (cursor) next.job.cursor = cursor;
      else delete next.job.cursor;
    } else if (cursor !== undefined) next.job.cursor = cursor;
    else this.#pending.delete(this.#key(next.job));
    const elapsed = Math.max(0, now() - start);
    if (!signal.aborted) {
      this.#dutyUntil = now() + elapsed * (1 / this.policy.cpu - 1);
      if (!this.#requests.size) await this.#waitDuty(signal, true);
    }
    return true;
  }
  stop(): Promise<void> {
    return this.#stopping ??= this.#stop();
  }
  async #stop(): Promise<void> {
    this.#controller.abort();
    const errors: unknown[] = [];
    try {
      await this.#executing;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        errors.push(error);
      }
    }
    for (const sink of this.#sinks.values()) {
      try {
        await sink.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#pending.clear();
    this.#scopes.clear();
    this.#visibleSessions.clear();
    this.#visibleDirectories.clear();
    this.#interactive.clear();
    this.#sinks.clear();
    if (errors.length) {
      throw new AggregateError(errors, "Digest shutdown failed");
    }
  }
}
