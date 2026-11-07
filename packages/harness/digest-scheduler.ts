// SPDX-License-Identifier: LGPL-3.0-only
import { sessionListKey } from "@otk/protocol";
import type {
  DigestExecution,
  DigestIdentity,
  DigestJob,
  DigestPolicy,
  DigestPriority,
  DigestSink,
  DirtySession,
} from "./digest.ts";
import { ReadyQueue } from "./ready-queue.ts";
import { digestRowFloor } from "./digest.ts";
const rank: Record<DigestPriority, number> = {
  interactive: 0,
  attention: 1,
  visible: 2,
  background: 3,
};
interface Pending {
  optional: boolean;
  job: DigestJob;
  priority: DigestPriority;
  order: number;
  changed: boolean;
  active: boolean;
}
interface Turn {
  optional: boolean;
  priority(): number;
  order: number;
  signal: AbortSignal;
  resume(): Promise<void>;
  finishing(): boolean;
}
interface Lifetime {
  signal: AbortSignal;
  done: Promise<void>;
  reading(): boolean;
  priority(): number;
  running(): boolean;
  optional: boolean;
  preempt?: AbortController;
}
/** One cooperative executor. Waiting lifetimes have no executing turn. */
export class DigestScheduler {
  #sinks = new Map<string, DigestSink>();
  #pending = new Map<string, Pending>();
  #scopes = new Map<
    string,
    { directory?: string; sessions: string[]; pendingPage?: boolean }
  >();
  #pendingPages = false;
  #visibleSessions = new Set<string>();
  #visibleDirectories = new Set<string>();
  #interactive = new Set<string>();
  #controller = new AbortController();
  #executing?: Promise<boolean>;
  #order = 0;
  #stopping?: Promise<void>;
  #ready = new Set<Turn>();
  #turns = new ReadyQueue<Turn>((a, b) =>
    (a.signal.aborted ? -1 : a.priority()) <
      (b.signal.aborted ? -1 : b.priority()) ||
    (a.signal.aborted ? -1 : a.priority()) ===
          (b.signal.aborted ? -1 : b.priority()) && a.order < b.order
  );
  #idleTurns = new ReadyQueue<Turn>((a, b) =>
    a.priority() < b.priority() ||
    a.priority() === b.priority() && a.order < b.order
  );
  #finishing = new ReadyQueue<Turn>((a, b) =>
    (a.signal.aborted ? -1 : a.priority()) <
      (b.signal.aborted ? -1 : b.priority()) ||
    (a.signal.aborted ? -1 : a.priority()) ===
          (b.signal.aborted ? -1 : b.priority()) && a.order < b.order
  );
  #jobs = new ReadyQueue<Pending>((a, b) =>
    !a.optional && b.optional || a.optional === b.optional &&
      (this.#membership(a) < this.#membership(b) ||
        this.#membership(a) === this.#membership(b) &&
          (this.#priority(a) < this.#priority(b) ||
            this.#priority(a) === this.#priority(b) &&
              (a.job.updated > b.job.updated ||
                a.job.updated === b.job.updated && a.order < b.order)))
  );
  #viewers = true;
  #rows?: number;
  #lifetimes = new Set<Lifetime>();
  #errors: unknown[] = [];
  #backoffs = new Set<Promise<void>>();
  #dutyUntil = 0;
  #dutyWait?: AbortController;
  #changed = Promise.withResolvers<void>();
  #idleUntil = -Infinity;
  #idleWait?: AbortController;
  #batches = 0;
  #lists = new Map<string, Promise<void>>();
  #discovering = false;
  #discovered = false;
  #discoveryRevision = 0;
  discoveryChanged(): void {
    this.#discoveryRevision++;
    this.#discovered = false;
    this.#wake();
  }
  discoveryComplete(): void {
    this.#discoveryRevision++;
    this.#discovered = true;
    this.#wake();
  }
  /** One typed, idle-class successor per demanded list boundary, not a session ID. */
  prefetchList(
    input: import("@otk/protocol").SessionListInput,
    read: (signal: AbortSignal, execution: DigestExecution) => Promise<void>,
  ): void {
    const key = sessionListKey(input);
    if (this.#lists.has(key)) return;
    const task = this.execute(
      async (signal, execution) => {
        while (this.#batches >= this.policy.parallel) {
          await execution.wait(this.#changed.promise);
          signal.throwIfAborted();
        }
        this.#batches++;
        try {
          await read(signal, execution);
        } finally {
          this.#batches--;
          this.#wake();
        }
      },
      this.#controller.signal,
      "attention",
      true,
      false,
      true,
    )
      .catch((error) => {
        if (!this.#controller.signal.aborted) this.#errors.push(error);
      }).finally(() => {
        if (this.#lists.get(key) === task) this.#lists.delete(key);
      });
    this.#lists.set(key, task);
  }
  constructor(
    readonly policy: DigestPolicy,
    readonly resources: {
      freeMemory(): number;
      sleep(ms: number, signal: AbortSignal): Promise<void>;
      now?: () => number;
      wake?(): void;
      discover?(
        signal: AbortSignal,
        execution: DigestExecution,
      ): Promise<boolean>;
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
    optional = true,
  ): void {
    if (this.#controller.signal.aborted) return;
    if (!this.#sinks.has(identity.provider)) {
      throw new Error("Unknown digest sink");
    }
    const key = this.#key(identity), pending = this.#pending.get(key);
    if (pending) {
      if (identity.backfill === "high") pending.job.backfill = "high";
      if (!optional) pending.optional = false;
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
      if (!pending.active) this.#jobs.add(pending);
      this.#reindexTurns();
    } else {
      const value: Pending = {
        optional,
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
      };
      this.#pending.set(key, value);
      this.#jobs.add(value);
    }
    this.#wake();
  }
  promote(identity: DigestIdentity, priority: DigestPriority): boolean {
    const pending = this.#pending.get(this.#key(identity));
    if (!pending) return false;
    if (identity.backfill === "high") pending.job.backfill = "high";
    if (rank[priority] < rank[pending.priority]) pending.priority = priority;
    if (!pending.active) this.#jobs.add(pending);
    this.#reindexTurns();
    this.#wake();
    return true;
  }
  setScope(
    owner: string,
    scope: { directory?: string; sessions: string[]; pendingPage?: boolean },
  ): void {
    if (!this.#controller.signal.aborted) {
      this.#scopes.set(owner, structuredClone(scope));
      this.#viewers = true;
      this.#visibility();
    }
  }
  #visibility(): void {
    this.#pendingPages = [...this.#scopes.values()].some((scope) =>
      scope.pendingPage
    );
    this.#visibleSessions.clear();
    this.#visibleDirectories.clear();
    for (const scope of this.#scopes.values()) {
      for (const id of scope.sessions) this.#visibleSessions.add(id);
      if (scope.directory !== undefined) {
        this.#visibleDirectories.add(scope.directory);
      }
    }
    for (const pending of this.#pending.values()) {
      if (!pending.active) this.#jobs.add(pending);
    }
    this.#reindexTurns();
    this.#wake();
  }
  #reindexTurns(): void {
    for (const turn of this.#ready) this.#indexTurn(turn);
  }
  #indexTurn(turn: Turn): void {
    this.#turns.delete(turn);
    this.#idleTurns.delete(turn);
    this.#finishing.delete(turn);
    (turn.finishing() || turn.signal.aborted
      ? this.#finishing
      : turn.optional
      ? this.#idleTurns
      : this.#turns)
      .add(
        turn,
      );
  }
  /** Presence is independent of scope: even an empty welcome view is a viewer. */
  viewers(active: boolean): void {
    this.#viewers = active;
    this.#pauseDisconnected();
    this.#reindexTurns();
    this.#wake();
  }
  /** A dependency owner changed a queued continuation's inherited priority. */
  reconsider(): void {
    this.#reindexTurns();
    this.#wake();
  }
  /** Serving-isolate reduction/encoding belongs to the same background duty bill. */
  charge(elapsed: number): void {
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new TypeError("Invalid digest work measurement");
    }
    this.#dutyUntil = Math.max(this.#now(), this.#dutyUntil) +
      elapsed * (1 / this.policy.cpu - 1);
    this.#sleepDuty();
  }
  /** Client ingress, independent of executing pressure and passive acknowledgements. */
  requested(elapsed = 0): void {
    if (this.#controller.signal.aborted) return;
    this.#idleUntil = this.#now() + Math.max(0, this.policy.idlems - elapsed);
    this.#sleepIdle();
    this.#wake();
  }
  #sleepIdle(): void {
    if (this.#idleWait || this.#controller.signal.aborted) return;
    const remaining = this.#idleUntil - this.#now();
    if (remaining <= 0) return;
    const controller = this.#idleWait = new AbortController();
    void this.resources.sleep(
      remaining,
      AbortSignal.any([controller.signal, this.#controller.signal]),
    ).catch((error) => {
      if (!controller.signal.aborted && !this.#controller.signal.aborted) {
        this.#errors.push(error);
      }
    }).finally(() => {
      if (this.#idleWait === controller) this.#idleWait = undefined;
      this.#wake();
    });
  }
  #pauseDisconnected(): void {
    if (!this.#viewers && !this.policy.background) {
      for (const life of this.#lifetimes) {
        if (life.optional) {
          life.preempt?.abort(new DOMException("No viewers", "AbortError"));
        }
      }
    }
  }
  release(owner: string): void {
    this.#scopes.delete(owner);
    this.#viewers = this.#scopes.size > 0;
    this.#interactive.delete(owner);
    this.#visibility();
    this.#pauseDisconnected();
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
  get executing(): number {
    return [...this.#lifetimes].filter((life) => life.running()).length;
  }
  get waitReason(): string | undefined {
    if (!this.#viewers && !this.policy.background) {
      return "paused with no viewers";
    }
    if (this.#now() < this.#idleUntil) return "waiting for idle clients";
    if (this.#pendingPages) return "waiting for the current page";
    if (this.#interactive.size) return "queued behind current work";
    if (this.resources.freeMemory() < this.policy.memoryreserve) {
      return "paused for memory capacity";
    }
    if (this.#dutyUntil > this.#now()) {
      return "waiting for the background work budget";
    }
    return undefined;
  }
  #priority(pending: Pending): number {
    // An admitted slice drains its bounded commit/publication and I/O cleanup.
    // Only its source-free cursor is parked, never a permission or credit.
    if ((!this.#viewers || this.#pendingPages) && pending.active) {
      return rank.attention;
    }
    if (pending.job.backfill === "high") return rank.attention;
    const priority = rank[pending.priority];
    return priority > rank.visible &&
        (this.#visibleSessions.has(pending.job.sessionID) ||
          pending.job.directory !== undefined &&
            this.#visibleDirectories.has(pending.job.directory))
      ? rank.visible
      : priority;
  }
  #membership(pending: Pending): number {
    return pending.optional && pending.job.backfill !== "high" ? 1 : 0;
  }
  execute<T>(
    run: (signal: AbortSignal, execution: DigestExecution) => Promise<T>,
    signal: AbortSignal,
    priority: DigestPriority | (() => DigestPriority) = "interactive",
    interruptible = false,
    finishing: boolean | (() => boolean) = false,
    optional = false,
  ): Promise<T> {
    if (signal.aborted || this.#controller.signal.aborted) {
      return Promise.reject(signal.reason ?? this.#controller.signal.reason);
    }
    const current = () =>
      typeof priority === "function" ? priority() : priority;
    if (current() === "interactive") {
      this.#dutyWait?.abort();
    }
    return interruptible && typeof priority === "string" &&
        priority !== "interactive"
      ? this.#read(run, signal, priority, optional)
      : this.#job(
        run,
        signal,
        () => rank[current()],
        undefined,
        finishing,
        optional,
      );
  }
  /** Only explicitly revocable read callbacks may restart after I/O preemption. */
  async #read<T>(
    run: (signal: AbortSignal, execution: DigestExecution) => Promise<T>,
    signal: AbortSignal,
    priority: DigestPriority,
    optional: boolean,
  ): Promise<T> {
    while (true) {
      signal.throwIfAborted();
      this.#controller.signal.throwIfAborted();
      const slice = new AbortController();
      let admitted = false;
      try {
        return await this.#job(
          async (signal, execution) => {
            admitted = true;
            const value = await run(signal, execution);
            signal.throwIfAborted();
            return value;
          },
          AbortSignal.any([signal, slice.signal]),
          () => rank[priority],
          slice,
          () => optional && admitted,
          optional,
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
  interruptIO(signal?: AbortSignal): void {
    for (const life of this.#lifetimes) {
      if (
        (signal ? life.signal === signal : life.reading()) &&
        life.priority() > rank.interactive
      ) {
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
    finishing: boolean | (() => boolean) = false,
    optional = false,
  ): Promise<T> {
    const combined = AbortSignal.any([signal, this.#controller.signal]);
    const result = Promise.withResolvers<T>(),
      settled = Promise.withResolvers<void>();
    let waitKind: "readiness" | "io" | undefined;
    const lifetime = {
      signal: combined,
      done: settled.promise,
      priority,
      optional,
      preempt,
      reading: () => waitKind === "io",
      running: () => phase === "running",
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
      if (turn) {
        this.#ready.delete(turn);
        this.#turns.delete(turn);
        this.#idleTurns.delete(turn);
        this.#finishing.delete(turn);
      }
      combined.removeEventListener("abort", cancel);
      this.#lifetimes.delete(lifetime);
      settled.resolve();
      this.#wake();
    };
    const queue = (resume: () => void) => {
      phase = "queued";
      turn = {
        optional,
        finishing: () =>
          typeof finishing === "function" ? finishing() : finishing,
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
      this.#indexTurn(turn);
      this.#wake();
    };
    const cancel = () => {
      if (turn) this.#indexTurn(turn);
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
  #eligible(priority: number, signal?: AbortSignal, optional = false): boolean {
    if (signal?.aborted) return true; // Canceled continuations still join their cleanup.
    if (optional) {
      if ((!this.#viewers && !this.policy.background) || this.#pendingPages) {
        return false;
      }
      if (this.#now() < this.#idleUntil) {
        this.#sleepIdle();
        return false;
      }
    }
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
    let turn = this.#turns.peek();
    if (turn && !this.#eligible(turn.priority(), turn.signal, turn.optional)) {
      turn = undefined;
    }
    const idleTurn = this.#idleTurns.peek();
    if (
      idleTurn && (!turn || idleTurn.priority() < turn.priority()) &&
      this.#eligible(idleTurn.priority(), idleTurn.signal, true)
    ) turn = idleTurn;
    const finishing = this.#finishing.peek();
    if (
      finishing &&
      (!turn || finishing.signal.aborted ||
        finishing.priority() < turn.priority())
    ) turn = finishing;
    const next = this.#controller.signal.aborted
      ? undefined
      : this.#jobs.peek();
    if (
      next &&
      (!next.optional || this.#batches < this.policy.parallel) &&
      (!turn ||
        this.#priority(next) < (turn.signal.aborted ? -1 : turn.priority())) &&
      this.#eligible(this.#priority(next), undefined, next.optional)
    ) {
      const pending = next;
      // Admission belongs to this batch, even if later demand upgrades its key.
      const optional = pending.optional;
      const slice = new AbortController();
      let failed = false;
      pending.active = true;
      if (optional) this.#batches++;
      this.#jobs.delete(pending);
      pending.changed = false;
      void this.#job(
        async (signal, execution) => {
          const cursor = await this.#sinks.get(pending.job.provider)!.step(
            structuredClone(pending.job),
            {
              rows: this.#rows ?? this.policy.batch,
              until: this.#now() + this.policy.slicems,
            },
            signal,
            execution,
          );
          // Adapt the next row quota to observed executing work, not I/O waits.
          if (execution.workms > this.policy.slicems) {
            this.#rows = Math.max(
              digestRowFloor(this.policy),
              Math.floor(
                (this.#rows ?? this.policy.batch) * this.policy.slicems /
                  execution.workms,
              ),
            );
          }
          signal.throwIfAborted();
          if (pending.changed || cursor !== undefined) {
            if (cursor) pending.job.cursor = cursor;
            else delete pending.job.cursor;
          } else this.#pending.delete(this.#key(pending.job));
        },
        AbortSignal.any([this.#controller.signal, slice.signal]),
        () => this.#priority(pending),
        slice,
        () => pending.active,
        optional,
      ).catch((error) => {
        if (!this.#controller.signal.aborted && !slice.signal.aborted) {
          failed = true;
          this.#errors.push(error);
        }
      }).finally(() => {
        if (optional) this.#batches--;
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
            if (this.#pending.has(this.#key(pending.job))) {
              this.#jobs.add(pending);
            }
            this.#backoffs.delete(backoff);
            this.#wake();
          });
          this.#backoffs.add(backoff);
        } else {
          pending.active = false;
          if (this.#pending.has(this.#key(pending.job))) {
            this.#jobs.add(pending);
          }
        }
        this.#wake();
      });
      return await this.#tick();
    }
    if (!turn) {
      if (
        !this.#pending.size && !this.#lists.size && !this.#discovering &&
        !this.#discovered && this.resources.discover &&
        !this.#controller.signal.aborted
      ) {
        this.#discovering = true;
        const revision = this.#discoveryRevision;
        void this.execute(
          async (signal, execution) => {
            // Demand may arrive after this source-free discovery turn was queued.
            if (this.#discovered) return false;
            if (this.#pending.size || this.#lists.size) return true;
            if (this.#batches >= this.policy.parallel) return true;
            this.#batches++;
            try {
              return await this.resources.discover!(signal, execution);
            } finally {
              this.#batches--;
              this.#wake();
            }
          },
          this.#controller.signal,
          "background",
          true,
          false,
          true,
        ).then((more) => {
          if (revision === this.#discoveryRevision) this.#discovered = !more;
        }, (error) => {
          if (!this.#controller.signal.aborted) this.#errors.push(error);
          this.#discovered = true;
        }).finally(() => {
          this.#discovering = false;
          this.#wake();
        });
        return await this.#tick();
      }
      return false;
    }
    this.#ready.delete(turn);
    this.#turns.delete(turn);
    this.#idleTurns.delete(turn);
    this.#finishing.delete(turn);
    await turn.resume();
    return true;
  }
  stop(): Promise<void> {
    return this.#stopping ??= this.#stop();
  }
  async #stop(): Promise<void> {
    this.#controller.abort();
    this.#dutyWait?.abort();
    this.#idleWait?.abort();
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
