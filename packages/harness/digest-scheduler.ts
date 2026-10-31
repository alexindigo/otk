// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DigestExecution,
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
  active: boolean;
}
interface Turn {
  priority(): number;
  order: number;
  signal: AbortSignal;
  resume(): Promise<void>;
}
interface Lifetime {
  done: Promise<void>;
  reading(): boolean;
  priority(): number;
  preempt?: AbortController;
}
/** One cooperative executor. Waiting lifetimes have no executing turn. */
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
  #ready = new Set<Turn>();
  #lifetimes = new Set<Lifetime>();
  #errors: unknown[] = [];
  #backoffs = new Set<Promise<void>>();
  #dutyUntil = 0;
  #dutyWait?: AbortController;
  #changed = Promise.withResolvers<void>();
  constructor(
    readonly policy: DigestPolicy,
    readonly resources: {
      freeMemory(): number;
      sleep(ms: number, signal: AbortSignal): Promise<void>;
      now?: () => number;
      wake?(): void;
    },
  ) {}
  #now(): number {
    return this.resources.now?.() ?? performance.now();
  }
  #wake(): void {
    const changed = this.#changed;
    this.#changed = Promise.withResolvers<void>();
    changed.resolve();
    this.resources.wake?.();
  }
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
    const key = this.#key(identity), pending = this.#pending.get(key);
    if (pending) {
      if (rank[priority] < rank[pending.priority]) pending.priority = priority;
      pending.job.updated = Math.max(pending.job.updated, identity.updated);
      pending.job.revision = Math.max(
        pending.job.revision,
        dirty?.revision ?? 0,
      );
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
        active: false,
      });}
    this.#wake();
  }
  promote(identity: DigestIdentity, priority: DigestPriority): boolean {
    const pending = this.#pending.get(this.#key(identity));
    if (!pending) return false;
    if (rank[priority] < rank[pending.priority]) pending.priority = priority;
    this.#wake();
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
    this.#wake();
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
    this.#wake();
  }
  get queued(): number {
    return this.#pending.size;
  }
  #priority(pending: Pending): number {
    const priority = rank[pending.priority];
    return priority > rank.visible &&
        (this.#visibleSessions.has(pending.job.sessionID) ||
          pending.job.directory !== undefined &&
            this.#visibleDirectories.has(pending.job.directory))
      ? rank.visible
      : priority;
  }
  execute<T>(
    run: (signal: AbortSignal, execution: DigestExecution) => Promise<T>,
    signal: AbortSignal,
    priority: DigestPriority = "interactive",
    interruptible = false,
  ): Promise<T> {
    if (signal.aborted || this.#controller.signal.aborted) {
      return Promise.reject(signal.reason ?? this.#controller.signal.reason);
    }
    if (priority === "interactive") {
      this.#dutyWait?.abort();
    }
    return interruptible && priority !== "interactive"
      ? this.#read(run, signal, priority)
      : this.#job(run, signal, () => rank[priority]);
  }
  /** Only explicitly revocable read callbacks may restart after I/O preemption. */
  async #read<T>(
    run: (signal: AbortSignal, execution: DigestExecution) => Promise<T>,
    signal: AbortSignal,
    priority: DigestPriority,
  ): Promise<T> {
    while (true) {
      signal.throwIfAborted();
      this.#controller.signal.throwIfAborted();
      const slice = new AbortController();
      try {
        return await this.#job(
          async (signal, execution) => {
            const value = await run(signal, execution);
            signal.throwIfAborted();
            return value;
          },
          AbortSignal.any([signal, slice.signal]),
          () => rank[priority],
          slice,
        );
      } catch (error) {
        if (
          !slice.signal.aborted || signal.aborted ||
          this.#controller.signal.aborted
        ) throw error;
      }
    }
  }
  /** The I/O-permission owner requests preemption only when a read needs it. */
  interruptIO(): void {
    for (const life of this.#lifetimes) {
      if (life.reading() && life.priority() > rank.interactive) {
        life.preempt?.abort(
          new DOMException("Essential digest I/O demand", "AbortError"),
        );
      }
    }
  }
  #job<T>(
    run: (signal: AbortSignal, execution: DigestExecution) => Promise<T>,
    signal: AbortSignal,
    priority: () => number,
    preempt?: AbortController,
  ): Promise<T> {
    const combined = AbortSignal.any([signal, this.#controller.signal]);
    const result = Promise.withResolvers<T>(),
      settled = Promise.withResolvers<void>();
    let waitKind: "readiness" | "io" | undefined;
    const lifetime = {
      done: settled.promise,
      priority,
      preempt,
      reading: () => waitKind === "io",
    };
    this.#lifetimes.add(lifetime);
    let phase: "queued" | "running" | "waiting" | "done" = "queued",
      started = false;
    let turn: Turn | undefined,
      released: PromiseWithResolvers<void> | undefined;
    let at = 0, workms = 0;
    const release = (next: typeof phase) => {
      if (phase === "running") {
        const elapsed = Math.max(0, this.#now() - at);
        workms += elapsed;
        if (priority() > rank.interactive && !combined.aborted) {
          this.#dutyUntil = Math.max(this.#now(), this.#dutyUntil) +
            elapsed * (1 / this.policy.cpu - 1);
          this.#sleepDuty();
        }
      }
      phase = next;
      released?.resolve();
      released = undefined;
    };
    const finish = () => {
      release("done");
      if (turn) this.#ready.delete(turn);
      combined.removeEventListener("abort", cancel);
      this.#lifetimes.delete(lifetime);
      settled.resolve();
      this.#wake();
    };
    const queue = (resume: () => void) => {
      phase = "queued";
      turn = {
        priority,
        order: this.#order++,
        signal: combined,
        resume: () => {
          turn = undefined;
          phase = "running";
          at = this.#now();
          released = Promise.withResolvers<void>();
          const current = released.promise;
          resume();
          return current;
        },
      };
      this.#ready.add(turn);
      this.#wake();
    };
    const cancel = () => {
      if (!started) {
        result.reject(combined.reason);
        finish();
      }
      this.#wake();
    };
    const suspend = async <U>(
      value: PromiseLike<U>,
      kind: "readiness" | "io",
      join = false,
    ): Promise<U> => {
      if (phase !== "running") {
        throw new Error("Digest wait requires its executing turn");
      }
      const ready = Promise.withResolvers<{ value: U } | { error: unknown }>();
      const abort = () => ready.resolve({ error: combined.reason });
      if (!join) combined.addEventListener("abort", abort, { once: true });
      void Promise.resolve(value).then(
        (value) => ready.resolve({ value }),
        (error) => ready.resolve({ error }),
      );
      if (!join && combined.aborted) abort();
      waitKind = kind;
      release("waiting");
      const outcome = await ready.promise;
      combined.removeEventListener("abort", abort);
      const admitted = Promise.withResolvers<void>();
      queue(() => admitted.resolve());
      await admitted.promise;
      waitKind = undefined;
      if (!join) combined.throwIfAborted();
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    };
    const execution: DigestExecution = {
      get priority() {
        return (Object.keys(rank) as DigestPriority[]).find((value) =>
          rank[value] === priority()
        )!;
      },
      get workms() {
        return workms;
      },
      wait: (value, kind = "readiness") => suspend(value, kind),
      join: (value) => suspend(value, "io", true),
      charge: (elapsed) => {
        if (!Number.isFinite(elapsed) || elapsed < 0) {
          throw new TypeError("Invalid digest work measurement");
        }
        workms += elapsed;
        if (priority() > rank.interactive && !this.#controller.signal.aborted) {
          this.#dutyUntil = Math.max(this.#now(), this.#dutyUntil) +
            elapsed * (1 / this.policy.cpu - 1);
          this.#sleepDuty();
        }
      },
    };
    combined.addEventListener("abort", cancel, { once: true });
    queue(() => {
      started = true;
      let task: Promise<T>;
      try {
        combined.throwIfAborted();
        task = run(combined, execution);
      } catch (error) {
        task = Promise.reject(error);
      }
      void task.then(result.resolve, result.reject).finally(finish);
    });
    return result.promise;
  }
  #sleepDuty(): void {
    const remaining = this.#dutyUntil - this.#now();
    if (this.#dutyWait || this.#controller.signal.aborted || remaining <= 0) {
      return;
    }
    const controller = this.#dutyWait = new AbortController();
    void this.resources.sleep(
      remaining,
      AbortSignal.any([controller.signal, this.#controller.signal]),
    ).then(() => {
      if (!controller.signal.aborted) this.#dutyUntil = 0;
    }, (error) => {
      if (!controller.signal.aborted && !this.#controller.signal.aborted) {
        this.#errors.push(error);
      }
    }).finally(() => {
      if (this.#dutyWait === controller) this.#dutyWait = undefined;
      this.#wake();
    });
  }
  #eligible(priority: number, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true; // Canceled continuations still join their cleanup.
    if (priority === rank.interactive) return true;
    if (this.#controller.signal.aborted) return false;
    if (this.#dutyUntil > this.#now()) {
      this.#sleepDuty();
      return false;
    }
    return !this.#interactive.size &&
      this.resources.freeMemory() >= this.policy.memoryreserve;
  }
  tick(): Promise<boolean> {
    return this.#executing ??= this.#tick().finally(() => {
      this.#executing = undefined;
    });
  }
  async #tick(): Promise<boolean> {
    if (this.#errors.length) throw this.#errors.shift();
    let turn: Turn | undefined;
    for (const candidate of this.#ready) {
      if (
        !turn ||
        (candidate.signal.aborted ? -1 : candidate.priority()) <
          (turn.signal.aborted ? -1 : turn.priority()) ||
        candidate.priority() === turn.priority() && candidate.order < turn.order
      ) turn = candidate;
    }
    let next: Pending | undefined;
    if (!this.#controller.signal.aborted) {
      for (const pending of this.#pending.values()) {
        if (pending.active) {
          continue;
        }
        if (
          !next || this.#priority(pending) < this.#priority(next) ||
          this.#priority(pending) === this.#priority(next) &&
            (pending.job.updated > next.job.updated ||
              pending.job.updated === next.job.updated &&
                pending.order < next.order)
        ) next = pending;
      }
    }
    if (
      next &&
      (!turn ||
        this.#priority(next) < (turn.signal.aborted ? -1 : turn.priority()))
    ) {
      if (!this.#eligible(this.#priority(next))) return false;
      const pending = next;
      const slice = new AbortController();
      let failed = false;
      pending.active = true;
      pending.changed = false;
      void this.#job(
        async (signal, execution) => {
          const cursor = await this.#sinks.get(pending.job.provider)!.step(
            structuredClone(pending.job),
            {
              rows: this.policy.batch,
              until: this.#now() + this.policy.slicems,
            },
            signal,
            execution,
          );
          signal.throwIfAborted();
          if (pending.changed || cursor !== undefined) {
            if (cursor) pending.job.cursor = cursor;
            else delete pending.job.cursor;
          } else this.#pending.delete(this.#key(pending.job));
        },
        AbortSignal.any([this.#controller.signal, slice.signal]),
        () => this.#priority(pending),
        slice,
      ).catch((error) => {
        if (!this.#controller.signal.aborted && !slice.signal.aborted) {
          failed = true;
          this.#errors.push(error);
        }
      }).finally(() => {
        if (failed && !this.#controller.signal.aborted) {
          // Only this identity waits after failure. Its backoff cannot suspend
          // the dispatcher or consume execution needed by essential callers.
          const backoff = this.resources.sleep(
            this.policy.retryms,
            this.#controller.signal,
          ).catch((error) => {
            if (!this.#controller.signal.aborted) this.#errors.push(error);
          }).finally(() => {
            pending.active = false;
            this.#backoffs.delete(backoff);
            this.#wake();
          });
          this.#backoffs.add(backoff);
        } else pending.active = false;
        this.#wake();
      });
      return await this.#tick();
    }
    if (!turn) return false;
    if (!this.#eligible(turn.priority(), turn.signal)) return false;
    this.#ready.delete(turn);
    await turn.resume();
    return true;
  }
  stop(): Promise<void> {
    return this.#stopping ??= this.#stop();
  }
  async #stop(): Promise<void> {
    this.#controller.abort();
    this.#dutyWait?.abort();
    const errors: unknown[] = [];
    try {
      await this.#executing;
    } catch (error) {
      errors.push(error);
    }
    while (this.#lifetimes.size) {
      try {
        const changed = this.#changed.promise;
        if (await this.tick()) continue;
        await changed;
      } catch (error) {
        errors.push(error);
      }
    }
    await Promise.allSettled([...this.#backoffs]);
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
