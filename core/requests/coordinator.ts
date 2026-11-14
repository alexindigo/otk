// SPDX-License-Identifier: LGPL-3.0-only
import {
  canonicalRequest,
  OperationFailure,
  requestFingerprint,
  requestRef,
} from "@otk/protocol";
import type {
  PublicFailure,
  ReceiptData,
  RequestControl,
  RequestEvent,
  RequestPolicy,
  RequestProgress,
  RequestRef,
  RequestWindow,
  ViewLease,
} from "@otk/protocol";
import type { ReceiptKey, RequestRecord, Requests } from "@otk/store";
import type { RequestLifetime, RpcRegistry } from "../ws/registry.ts";
import type {
  PreparedRequest,
  RequestExecution,
  RpcExecutionPolicy,
} from "./types.ts";
import { ExecutionFailure, publicFailure } from "./failures.ts";

export type RequestRepository = Pick<
  Requests,
  | "get"
  | "admit"
  | "transition"
  | "inFlight"
  | "sweep"
  | "window"
  | "windowInfo"
  | "activeCount"
>;
export interface RequestRecipient {
  send(event: RequestEvent): void;
  lease: RequestLifetime;
}
interface Entry {
  record: RequestRecord;
  ref: RequestRef;
  policy: RpcExecutionPolicy<never, unknown>;
  prepared?: PreparedRequest;
  controller: AbortController;
  recipients: Map<RequestRecipient, RequestRef>;
  bytes: number;
  result?: { value: unknown; bytes: number };
  work?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  turn?: { ready: Promise<void>; release(): void };
  waiting: number;
  view?: ViewLease;
}
export interface CoordinatorOptions {
  registry: RpcRegistry;
  receipts: RequestRepository;
  policy: RequestPolicy;
  clock?: () => number;
  diagnostic?: (id: string, cause: unknown) => void;
  bootstrap?: boolean;
  fingerprint?: (canonical: string) => Promise<string>;
}
const identity = (key: ReceiptKey) =>
  JSON.stringify([key.principal, key.client_id, key.intent_key]);
const keyOf = (principal: string, ref: RequestRef): ReceiptKey => ({
  principal,
  client_id: ref.clientID,
  intent_key: ref.key,
});
const terminal = (record: RequestRecord) =>
  ["succeeded", "failed", "released"].includes(record.state);
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;

/** One admission/execution owner, independent of socket and presentation lifetimes. */
export class RequestCoordinator {
  #entries = new Map<string, Entry>();
  #leases = new Map<
    string,
    Map<RequestRecipient, { lifetime: RequestLifetime; close(): void }>
  >();
  #queues = new Map<string, Promise<void>>();
  // Preserve each sender's input order before asynchronous fingerprints finish.
  // This orders admission only; execution/readiness remains independently scoped.
  #admissions = new Map<string, Promise<void>>();
  // Semantic effect ordering is distinct from the yielded executing turn.
  #effects = new Map<string, Promise<void>>();
  #run = crypto.randomUUID();
  #started = false;
  #stopped = false;
  #jobs = new Set<Promise<void>>();
  #resultBytes = 0;
  #maintenance?: MapIterator<Entry>;
  constructor(readonly options: CoordinatorOptions) {}
  #now(): number {
    return (this.options.clock ?? Date.now)();
  }
  #failure(
    cause: unknown,
    method?: string,
    scope?: { sessionID?: string; directory?: string },
  ): PublicFailure {
    return publicFailure(cause, this.options.diagnostic ?? (() => {}), {
      ...(method ? { action: method } : {}),
      ...(scope ? { target: scope } : {}),
    });
  }
  window(): RequestWindow {
    const value = this.options.receipts.window(
      this.#now(),
      this.options.policy.windowms,
    );
    return { id: value.id, expiresAt: value.expires_at };
  }
  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    let after: ReceiptKey | undefined;
    for (;;) {
      const rows = this.options.receipts.inFlight(
        after,
        this.options.policy.resumebatch,
      );
      for (const record of rows) {
        const policy = this.options.registry.policy(record.method);
        if (!policy) throw new Error("Missing recovery registration");
        const ref = {
          clientID: record.client_id,
          key: record.intent_key,
          window: record.window_id,
          id: crypto.randomUUID(),
        };
        const entry = this.#entry(record, ref, policy);
        if (record.execution === "lease") {
          this.#transition(entry, { state: "released" });
        } else if (record.dispatched_at !== null) this.#schedule(entry, true);
        else {
          this.#transition(entry, {
            owner_run: null,
            state: "waiting",
            progress_code: "input-required",
          });
        }
      }
      if (rows.length < this.options.policy.resumebatch) break;
      after = rows.at(-1)!;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.#started = true;
  }
  #entry(
    record: RequestRecord,
    ref: RequestRef,
    policy: Entry["policy"],
  ): Entry {
    const id = identity(record);
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = {
        record,
        ref,
        policy,
        controller: new AbortController(),
        recipients: new Map(),
        bytes: 0,
        waiting: 0,
      };
      this.#entries.set(id, entry);
    }
    return entry;
  }
  #transition(entry: Entry, patch: Partial<RequestRecord>): void {
    entry.record = this.options.receipts.transition(
      entry.record,
      entry.record.seq,
      { ...patch, updated_at: this.#now() },
    );
  }
  #refresh(entry: Entry): boolean {
    const current = this.options.receipts.get(entry.record);
    if (!current || current.seq === entry.record.seq) return false;
    entry.record = current;
    for (const [recipient, ref] of entry.recipients) {
      this.#snapshot(entry, recipient, ref, true);
    }
    return true;
  }
  #emit(entry: Entry, event: RequestEvent): void {
    for (const [recipient, ref] of entry.recipients) {
      try {
        recipient.send({ ...event, ref });
      } catch {
        entry.recipients.delete(recipient);
      }
    }
  }
  #progress(entry: Entry, progress: RequestProgress): void {
    if (terminal(entry.record)) {
      if (entry.record.state === "succeeded" && entry.policy.kind === "read") {
        this.#emit(entry, {
          t: "request.progress",
          ref: entry.ref,
          seq: entry.record.seq,
          progress,
        });
      }
      return;
    }
    this.#transition(entry, {
      state: progress.phase,
      ...(progress.phase === "running" ? { owner_run: this.#run } : {}),
      progress_code: progress.code,
      progress_completed: progress.completed ?? null,
      progress_total: progress.total ?? null,
    });
    this.#emit(entry, {
      t: "request.progress",
      ref: entry.ref,
      seq: entry.record.seq,
      progress,
    });
  }
  #snapshot(
    entry: Entry,
    recipient: RequestRecipient,
    ref: RequestRef,
    replayed: boolean,
  ): void {
    const record = entry.record;
    try {
      recipient.send({
        t: "request.accepted",
        ref,
        seq: record.seq,
        acceptedAt: record.accepted_at,
        retentionUntil: record.retention_until,
        replayed,
      });
      if (record.state === "failed") {
        recipient.send({
          t: "request.result",
          ref,
          seq: record.seq,
          outcome: {
            ok: false,
            error: {
              code: record.error_code!,
              retry: record.error_retry!,
              diagnosticID: record.diagnostic_id!,
              ...(record.error_field ? { field: record.error_field } : {}),
              facts: record.error_facts ? JSON.parse(record.error_facts) : {
                action: record.method,
                target: {
                  sessionID: record.scope_session ?? undefined,
                  directory: record.scope_directory ?? undefined,
                },
              },
            },
          },
        });
      } else if (entry.result) {
        recipient.send({
          t: "request.result",
          ref,
          seq: record.seq,
          outcome: { ok: true, result: entry.result.value },
        });
      } else if (!terminal(record)) {
        recipient.send({
          t: "request.progress",
          ref,
          seq: record.seq,
          progress: {
            phase: record.state as RequestProgress["phase"],
            code: (record.progress_code ?? "queued") as RequestProgress["code"],
          },
        });
      }
    } catch {
      entry.recipients.delete(recipient);
    }
  }
  async accept(
    principal: string,
    control: RequestControl,
    recipient: RequestRecipient,
  ): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Request coordinator is not admitting");
    }
    // Acquisition belongs to the view at ingress, before fingerprinting or
    // queued execution can yield to a newer socket view.
    const view = structuredClone(recipient.lease.view?.());
    if (control.t !== "request") {
      const refs = control.t === "request.resume"
        ? control.items
        : control.refs;
      if (refs.length > this.options.policy.resumebatch) {
        throw new TypeError("Request control batch too large");
      }
      for (const item of refs) {
        const ref = requestRef(
          "ref" in item ? item.ref : item,
          this.options.bootstrap,
        );
        if (control.t === "request.release") {
          this.#leases.get(identity(keyOf(principal, ref)))?.get(recipient)
            ?.close();
        }
        const record = this.options.receipts.get(keyOf(principal, ref));
        if (!record || record.window_id !== ref.window) {
          if (control.t !== "request.resume") continue;
          const live = !record && control.t === "request.resume" &&
            (this.options.receipts.windowInfo(ref.window)?.expires_at ?? 0) >
              this.#now();
          recipient.send({
            t: "request.rejected",
            ref,
            error: this.#failure(
              new ExecutionFailure({
                code: live ? "request.input-required" : "request.expired",
                retry: live ? "same-intent" : "none",
              }),
            ),
          });
          continue;
        }
        const policy = this.options.registry.policy(record.method);
        if (!policy) throw new Error("Missing execution registration");
        const entry = this.#entry(record, ref, policy);
        if (control.t === "request.release") {
          entry.recipients.delete(recipient);
          if (
            (policy.kind === "read" || policy.kind === "lease") &&
            !entry.recipients.size && !terminal(record)
          ) {
            entry.controller.abort();
            this.#transition(entry, { state: "released" });
          }
        } else if (control.t === "request.received") {
          if ("seq" in item && item.seq >= record.seq) {
            this.#dropResult(entry);
            entry.recipients.delete(recipient);
            this.#retire(entry);
          }
        } else {
          entry.recipients.set(recipient, ref);
          this.#snapshot(entry, recipient, ref, true);
          if (
            !entry.work &&
            (!terminal(entry.record) ||
              entry.record.state === "succeeded" && !entry.result &&
                entry.recipients.has(recipient))
          ) {
            entry.view = view;
            this.#schedule(
              entry,
              entry.record.dispatched_at !== null || terminal(entry.record),
            );
          }
        }
      }
      return;
    }
    const ref = requestRef(control.ref, this.options.bootstrap);
    let admission: { ready: Promise<void>; release(): void } | undefined;
    try {
      const prepared = this.options.registry.prepare(
        control.method,
        control.params,
      );
      if (!prepared.execution) {
        throw new ExecutionFailure({ code: "request.policy", retry: "none" });
      }
      const canonical = canonicalRequest(control.params);
      const size = new TextEncoder().encode(canonical).byteLength;
      if (size > this.options.policy.inputbytes) {
        throw new ExecutionFailure({
          code: "request.capacity",
          retry: "same-intent",
        });
      }
      admission = this.#admission(principal, ref.clientID);
      const [fingerprint] = await Promise.all([
        (this.options.fingerprint ?? requestFingerprint)(canonical),
        admission.ready,
      ]);
      if (this.#stopped) {
        throw new Error("Request coordinator is not admitting");
      }
      const key = keyOf(principal, ref), old = this.options.receipts.get(key);
      if (
        old &&
        (old.fingerprint !== fingerprint || old.method !== control.method ||
          old.window_id !== ref.window)
      ) throw new ExecutionFailure({ code: "request.conflict", retry: "none" });
      if (!old || !terminal(old) && old.dispatched_at === null) {
        const retained = [...this.#entries.values()].filter((entry) =>
          entry.record.principal === principal
        ).reduce((total, entry) => total + entry.bytes, 0);
        const previousBytes = this.#entries.get(identity(key))?.bytes ?? 0;
        if (
          !old && this.options.receipts.activeCount(principal) >=
              this.options.policy.maxpending ||
          retained - previousBytes + size > this.options.policy.inputbytes
        ) {
          throw new ExecutionFailure({
            code: "request.capacity",
            retry: "same-intent",
          });
        }
      }
      const now = this.#now(),
        window = this.options.receipts.windowInfo(ref.window);
      if (!old && (!window || window.expires_at <= now)) {
        throw new ExecutionFailure({ code: "request.expired", retry: "none" });
      }
      const scope = prepared.scope;
      const admitted = this.options.receipts.admit({
        ...key,
        window_id: ref.window,
        method: control.method,
        fingerprint,
        execution: prepared.execution.kind === "prepared-local"
          ? "local"
          : prepared.execution.kind,
        state: "queued",
        seq: 1,
        accepted_at: now,
        updated_at: now,
        retention_until: old?.retention_until ??
          Math.max(now, window!.expires_at) + this.options.policy.retentionms,
        dispatched_at: null,
        owner_run: null,
        scope_session: scope.sessionID ?? null,
        scope_directory: scope.directory ?? null,
        scope_resource: scope.resource ?? null,
        progress_code: "queued",
        progress_completed: null,
        progress_total: null,
        receipt_kind: null,
        receipt_json: null,
        error_code: null,
        error_retry: null,
        error_field: null,
        diagnostic_id: null,
        error_facts: null,
      });
      const entry = this.#entry(admitted.record, ref, prepared.execution);
      if (
        entry.record.dispatched_at === null || entry.policy.kind === "read" ||
        terminal(entry.record)
      ) entry.prepared = prepared;
      entry.bytes =
        terminal(entry.record) || entry.record.dispatched_at !== null
          ? 0
          : size;
      entry.recipients.set(recipient, ref);
      this.#snapshot(entry, recipient, ref, !admitted.inserted);
      if (
        !entry.work &&
        (!terminal(entry.record) ||
          entry.record.state === "succeeded" && !entry.result &&
            entry.recipients.has(recipient))
      ) {
        entry.view = view;
        this.#schedule(
          entry,
          !admitted.inserted &&
            (entry.record.dispatched_at !== null || terminal(entry.record)),
        );
      }
    } catch (cause) {
      recipient.send({
        t: "request.rejected",
        ref,
        error: this.#failure(cause, control.method),
      });
    } finally {
      admission?.release();
    }
  }
  #admission(principal: string, clientID: string) {
    const key = JSON.stringify([principal, clientID]);
    const ready = this.#admissions.get(key) ?? Promise.resolve();
    const released = Promise.withResolvers<void>();
    const tail = ready.then(() => released.promise);
    this.#admissions.set(key, tail);
    return {
      ready,
      release: () => {
        released.resolve();
        if (this.#admissions.get(key) === tail) this.#admissions.delete(key);
      },
    };
  }
  async #acquire(entry: Entry, queue?: string): Promise<void> {
    if (queue && !entry.turn) {
      const predecessor = this.#queues.get(queue);
      const released = Promise.withResolvers<void>();
      const ready = Promise.resolve(predecessor);
      const tail = ready.then(() => released.promise);
      this.#queues.set(queue, tail);
      entry.turn = {
        ready,
        release: () => {
          released.resolve();
          if (this.#queues.get(queue) === tail) this.#queues.delete(queue);
        },
      };
    }
    await entry.turn?.ready;
  }
  #yield(entry: Entry): void {
    entry.turn?.release();
    entry.turn = undefined;
  }
  #execution(entry: Entry, queue?: string): RequestExecution {
    return {
      key: {
        clientID: entry.ref.clientID,
        key: entry.ref.key,
        window: entry.ref.window,
      },
      signal: entry.controller.signal,
      progress: (value) => this.#progress(entry, value),
      wait: async <T>(ready: Promise<T>): Promise<T> => {
        if (entry.waiting++ === 0) {
          this.#yield(entry);
          this.#progress(entry, {
            phase: "waiting",
            // Yielding I/O is not evidence that the backend is unavailable.
            // Keep action-specific pending copy until actual liveness evidence.
            code: "working",
          });
        }
        try {
          return await ready;
        } finally {
          if (
            --entry.waiting === 0 && !this.#stopped &&
            !entry.controller.signal.aborted
          ) {
            await this.#acquire(entry, queue);
            entry.controller.signal.throwIfAborted();
            this.#progress(entry, { phase: "running", code: "working" });
          }
        }
      },
      beforeEffect: () => {
        entry.controller.signal.throwIfAborted();
        if (entry.record.dispatched_at === null) {
          this.#transition(entry, {
            dispatched_at: this.#now(),
            owner_run: this.#run,
          });
        }
        return Promise.resolve();
      },
      checkpoint: (kind, receipt) => {
        if (!entry.policy.checkpoint) {
          throw new Error("Checkpoint encoder not registered");
        }
        const encoded: { kind: string; value: unknown } = receipt;
        if (kind !== encoded.kind) {
          throw new TypeError("Checkpoint kind mismatch");
        }
        this.#transition(
          entry,
          this.#receipt(entry.policy.checkpoint(receipt)),
        );
        return Promise.resolve();
      },
      local: (run, encode) => {
        if (
          entry.policy.kind !== "local" &&
          entry.policy.kind !== "prepared-local" &&
          !(entry.policy.kind === "native" &&
            entry.record.dispatched_at !== null &&
            entry.record.receipt_json !== null)
        ) {
          throw new Error("Not a local execution");
        }
        let next: RequestRecord | undefined;
        const result = this.options.registry.context.store.write((tx) => {
          const value = run(tx);
          const receipt = encode(value);
          if (
            canonicalRequest(receipt) !==
              canonicalRequest(
                entry.policy.completion
                  ? entry.policy.completion(receipt)
                  : entry.policy.receipt(value),
              )
          ) throw new Error("Receipt encoder mismatch");
          next = this.options.receipts.transition(
            entry.record,
            entry.record.seq,
            {
              state: "succeeded",
              ...this.#receipt(receipt),
              updated_at: this.#now(),
            },
            tx,
          );
          return value;
        });
        entry.record = next!;
        return result;
      },
    };
  }
  #receipt(
    receipt: ReceiptData,
  ): Pick<RequestRecord, "receipt_kind" | "receipt_json"> {
    // ReceiptData is feature-contributed. Runtime encoders are the registration's boundary.
    const encoded: { kind: string; value: unknown } = receipt;
    return {
      receipt_kind: encoded.kind,
      receipt_json: canonicalRequest(encoded.value),
    };
  }
  #schedule(entry: Entry, recover: boolean): void {
    if (entry.work || this.#stopped) return;
    const scope = entry.record.scope_session;
    // Read/lease lifetimes never acquire an effect turn. A readiness wait yields
    // that turn, while native effects retain their independent I/O ordering.
    const queue = scope &&
        (entry.policy.kind === "local" ||
          entry.policy.kind === "prepared-local" ||
          entry.policy.kind === "native") &&
        entry.policy.priority !== "interrupt"
      ? JSON.stringify([entry.record.principal, scope])
      : undefined;
    const metadata = entry.policy.kind === "local" ||
      entry.policy.kind === "prepared-local";
    const target = entry.record.scope_resource
      ? ["resource", entry.record.scope_resource]
      : scope
      ? ["session", scope, entry.record.method]
      : entry.record.scope_directory
      ? ["directory", entry.record.scope_directory, entry.record.method]
      : undefined;
    const order = entry.policy.priority === "interrupt"
      ? undefined
      : entry.policy.kind === "native" && scope
      ? JSON.stringify([entry.record.principal, "native", scope])
      : metadata && entry.policy.ordering === "target" && target
      ? JSON.stringify([entry.record.principal, "metadata", target])
      : undefined;
    const predecessor = order ? this.#effects.get(order) : undefined;
    // Reserve ready work in admission order, but never reserve a turn while
    // waiting for another effect's semantic ordering permission.
    const admitted = predecessor ? undefined : this.#acquire(entry, queue);
    const cancelled = entry.prepared?.cancelled?.(this.#lifetime(entry));
    if (cancelled) {
      if (entry.controller.signal.aborted) cancelled();
      else {entry.controller.signal.addEventListener("abort", cancelled, {
          once: true,
        });}
    }
    const work = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      async () => {
        await predecessor;
        if (this.#stopped || entry.controller.signal.aborted) {
          await admitted;
          this.#yield(entry);
          return;
        }
        await (admitted ?? this.#acquire(entry, queue));
        if (this.#stopped || entry.controller.signal.aborted) {
          this.#yield(entry);
          return;
        }
        const execution = this.#execution(entry, queue);
        entry.timer = setTimeout(() => {
          if (this.#refresh(entry)) return;
          if (!terminal(entry.record)) {
            this.#progress(entry, {
              phase: entry.record.dispatched_at === null
                ? "waiting"
                : "reconciling",
              code: entry.record.dispatched_at === null
                ? "backend-unavailable"
                : "checking-outcome",
            });
          }
        }, this.options.policy.livenessms);
        try {
          if (recover) {
            const recovered = await execution.wait!(entry.policy.recover(
              this.options.registry.context,
              entry.record,
              execution,
            ));
            if (recovered.state === "pending") {
              this.#progress(entry, recovered.progress);
              return;
            }
            if (recovered.state === "complete") {
              this.#complete(entry, recovered.result);
              return;
            }
            if (entry.policy.kind !== "read") {
              this.#progress(entry, {
                phase: "reconciling",
                code: "checking-outcome",
              });
              return;
            }
          }
          if (!entry.prepared) {
            this.#progress(entry, { phase: "waiting", code: "input-required" });
            return;
          }
          if (
            entry.record.owner_run !== null &&
            entry.record.owner_run !== this.#run && !terminal(entry.record)
          ) {
            this.#refresh(entry);
            return;
          }
          if (!terminal(entry.record)) {
            this.#progress(entry, { phase: "running", code: "working" });
          }
          const result = await entry.prepared.run(
            execution,
            this.#lifetime(entry),
          );
          if (this.#stopped || entry.record.state === "released") return;
          if (
            (entry.policy.kind === "local" ||
              entry.policy.kind === "prepared-local") &&
            entry.record.state !== "succeeded"
          ) throw new Error("Local handler omitted atomic completion");
          this.#complete(entry, result);
        } catch (cause) {
          if (this.#stopped || entry.record.state === "released") return;
          // A losing CAS is ownership evidence, never a failed user action.
          if (this.#refresh(entry)) return;
          if (entry.record.state === "succeeded") {
            this.#progress(entry, { phase: "waiting", code: "publishing" });
            return;
          }
          if (
            cause instanceof OperationFailure && cause.outcome === "unavailable"
          ) {
            this.#progress(entry, {
              phase: "waiting",
              code: "backend-unavailable",
            });
          } else if (
            entry.record.dispatched_at !== null &&
            !(cause instanceof ExecutionFailure) &&
            !(cause instanceof OperationFailure && cause.outcome === "rejected")
          ) {
            this.#progress(entry, {
              phase: "reconciling",
              code: "checking-outcome",
            });
          } else {
            const failure = this.#failure(cause, entry.record.method, {
              sessionID: entry.record.scope_session ?? undefined,
              directory: entry.record.scope_directory ?? undefined,
            });
            this.#transition(entry, {
              state: "failed",
              error_code: failure.code,
              error_retry: failure.retry,
              error_field: failure.field ?? null,
              diagnostic_id: failure.diagnosticID,
              error_facts: JSON.stringify(failure.facts),
            });
            this.#emit(entry, {
              t: "request.result",
              ref: entry.ref,
              seq: entry.record.seq,
              outcome: { ok: false, error: failure },
            });
          }
        } finally {
          this.#yield(entry);
          clearTimeout(entry.timer);
          entry.timer = undefined;
          if (terminal(entry.record) || entry.record.dispatched_at !== null) {
            entry.bytes = 0;
            entry.prepared = undefined;
          }
        }
      },
    );
    entry.work = work;
    this.#jobs.add(work);
    if (order) {
      this.#effects.set(order, work);
    }
    const finish = () => {
      if (cancelled) {
        entry.controller.signal.removeEventListener("abort", cancelled);
      }
      this.#jobs.delete(work);
      entry.work = undefined;
      if (order && this.#effects.get(order) === work) {
        this.#effects.delete(order);
      }
      this.#retire(entry);
    };
    void work.then(finish, finish);
  }
  #complete(entry: Entry, result: unknown): void {
    if (!terminal(entry.record)) {
      const receipt = entry.policy.receipt(result);
      this.#transition(entry, {
        state: "succeeded",
        ...(receipt ? this.#receipt(receipt) : {}),
      });
    }
    const size = bytes(result);
    this.#dropResult(entry);
    if (size <= this.options.policy.resultbytes) {
      for (const other of this.#entries.values()) {
        if (this.#resultBytes + size <= this.options.policy.resultbytes) break;
        this.#dropResult(other);
        this.#retire(other);
      }
      entry.result = { value: result, bytes: size };
      this.#resultBytes += size;
    }
    this.#emit(entry, {
      t: "request.result",
      ref: entry.ref,
      seq: entry.record.seq,
      outcome: { ok: true, result },
    });
  }
  #retire(entry: Entry): void {
    if (
      terminal(entry.record) && !entry.result && !entry.recipients.size &&
      !entry.work
    ) this.#entries.delete(identity(entry.record));
  }
  #lifetime(entry: Entry): RequestLifetime | undefined {
    const recipient = entry.recipients.keys().next().value;
    if (!recipient || entry.policy.lifetime !== "request") {
      if (recipient && entry.policy.kind === "read" && entry.view) {
        const view = entry.view;
        return { ...recipient.lease, view: () => view };
      }
      return recipient?.lease;
    }
    const key = identity(entry.record),
      owners = this.#leases.get(key) ?? new Map();
    const existing = owners.get(recipient);
    if (existing) return existing.lifetime;
    const controller = new AbortController(), releases = new Set<() => void>();
    let detach = () => {};
    const close = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      detach();
      for (const release of releases) {
        try {
          release();
        } catch (cause) {
          this.options.diagnostic?.(crypto.randomUUID(), cause);
        }
      }
      releases.clear();
      owners.delete(recipient);
      if (!owners.size) this.#leases.delete(key);
    };
    const lifetime: RequestLifetime = {
      id: JSON.stringify([
        recipient.lease.id,
        entry.ref.clientID,
        entry.ref.key,
      ]),
      signal: controller.signal,
      publish: recipient.lease.publish,
      view: recipient.lease.view,
      entries: recipient.lease.entries,
      defer(release) {
        if (controller.signal.aborted) release();
        else releases.add(release);
        return () => {
          releases.delete(release);
        };
      },
    };
    owners.set(recipient, { lifetime, close });
    this.#leases.set(key, owners);
    const detached = recipient.lease.defer(close);
    if (typeof detached === "function") detach = detached;
    return lifetime;
  }
  #dropResult(entry: Entry): void {
    this.#resultBytes -= entry.result?.bytes ?? 0;
    entry.result = undefined;
  }
  detach(recipient: RequestRecipient): void {
    for (const owners of this.#leases.values()) owners.get(recipient)?.close();
    for (const entry of this.#entries.values()) {
      entry.recipients.delete(recipient);
      this.#retire(entry);
    }
  }
  async idle(): Promise<void> {
    while (this.#jobs.size) await Promise.all([...this.#jobs]);
  }
  maintenance(): number {
    const now = this.#now(), limit = this.options.policy.sweepbatch;
    this.#maintenance ??= this.#entries.values();
    for (let count = 0; count < limit; count++) {
      const next = this.#maintenance.next();
      if (next.done) {
        this.#maintenance = undefined;
        break;
      }
      const entry = next.value;
      if (terminal(entry.record) && entry.record.retention_until <= now) {
        this.#dropResult(entry);
        entry.recipients.clear();
        this.#retire(entry);
      }
    }
    return this.options.receipts.sweep(now, limit);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const owners of this.#leases.values()) {
      for (const lease of owners.values()) {
        lease.close();
      }
    }
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
      entry.recipients.clear();
      if (!terminal(entry.record) && entry.record.dispatched_at !== null) {
        this.#transition(entry, {
          state: "reconciling",
          progress_code: "checking-outcome",
        });
      }
      entry.controller.abort();
    }
    await this.idle();
    this.#entries.clear();
    this.#resultBytes = 0;
  }
}
