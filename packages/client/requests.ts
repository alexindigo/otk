// SPDX-License-Identifier: LGPL-3.0-only
import { canonicalRequest, requestRef } from "@otk/protocol";
import type {
  IntentIdentity,
  PublicFailure,
  RequestControl,
  RequestEvent,
  RequestPhase,
  RequestProgress,
  RequestRef,
  RequestWindow,
  RpcMethod,
  RpcParams,
  RpcResult,
} from "@otk/protocol";
import {
  failureFeedback,
  type FailurePresenter,
  type Feedback,
  RequestFailure,
  RequestReleased,
} from "./failures.ts";

export interface RequestOptions {
  signal?: AbortSignal;
  intent?: IntentIdentity;
  owner?: string;
}
export interface OperationState {
  ref: RequestRef;
  method: string;
  owner?: string;
  phase: "sending" | RequestPhase | "succeeded" | "failed" | "released";
  connection: "connected" | "reconnecting" | "authentication-required";
  seq: number;
  progress?: RequestProgress;
  error?: PublicFailure;
}
export interface Operation<R> {
  readonly state: Readonly<OperationState>;
  subscribe(listener: () => void): () => void;
  readonly result: Promise<R>;
  retry(): void;
  release(): void;
}
export interface RememberedRequests {
  version: 1;
  server: string;
  clientID: string;
  operations: (
    & Pick<
      OperationState,
      "ref" | "method" | "owner" | "seq" | "phase"
    >
    & { principal?: string }
  )[];
}
export interface RequestTrackerOptions {
  send(frame: RequestControl): void;
  /** Independent HTTP/bootstrap and socket readiness share the same intent owner. */
  available?(frame: RequestControl): boolean;
  clientID?: string;
  server?: string;
  /** Opaque authenticated identity supplied by the transport composition. */
  principal?: string;
  storage?: { load(): unknown; save(value: RememberedRequests): void };
  diagnostic?: (cause: unknown) => void;
  /** Feature-composed lifetime classification; conservative mutation otherwise. */
  kind?: (method: string) => "read" | "mutation" | "lease";
}
interface Pending {
  principal?: string;
  state: OperationState;
  params?: unknown;
  canonical?: string;
  operation: Operation<unknown>;
  listeners: Set<() => void>;
  resolve(value: unknown): void;
  reject(cause: Error): void;
  settled: boolean;
  submitted: boolean;
  snapshot: boolean;
  cleanup(): void;
}
const active = (state: OperationState) =>
  !["succeeded", "failed", "released"].includes(state.phase);

/** One long-lived sidecar owner. It never turns elapsed time into a result. */
export class RequestTracker {
  readonly clientID: string;
  #pending = new Map<string, Pending>();
  #listeners = new Set<() => void>();
  #window?: RequestWindow;
  #batch = 0;
  #connected = false;
  #stopped = false;
  #principal?: string;
  #controls = new Map<
    string,
    { control: RequestControl; principal?: string }
  >();
  constructor(readonly options: RequestTrackerOptions) {
    this.#principal = options.principal;
    const loaded = options.storage?.load();
    const saved = loaded && typeof loaded === "object"
      ? loaded as Partial<RememberedRequests>
      : undefined;
    this.clientID = options.clientID ??
      (saved?.version === 1 && saved.server === (options.server ?? "")
        ? saved.clientID
        : undefined) ??
      crypto.randomUUID();
    // Validate persisted metadata independently; payloads are never restored.
    if (
      saved?.version === 1 && saved.server === (options.server ?? "") &&
      saved.clientID === this.clientID && Array.isArray(saved.operations)
    ) {
      for (const item of saved.operations) {
        try {
          const ref = requestRef(item.ref);
          if (
            ref.clientID !== this.clientID || typeof item.method !== "string" ||
            !Number.isSafeInteger(item.seq) || item.seq < 0 ||
            typeof item.phase !== "string" ||
            ![
              "sending",
              "queued",
              "running",
              "waiting",
              "reconciling",
              "succeeded",
              "failed",
              "released",
            ].includes(item.phase)
          ) continue;
          if (item.phase === "failed" || item.phase === "released") continue;
          const restored = this.#create({
            ref,
            method: item.method,
            owner: typeof item.owner === "string" ? item.owner : undefined,
            seq: item.seq,
            phase: "reconciling",
            connection: "reconnecting",
          });
          restored.principal = typeof item.principal === "string"
            ? item.principal
            : options.principal;
        } catch (cause) {
          options.diagnostic?.(cause);
        }
      }
    }
  }
  #save(): void {
    try {
      this.options.storage?.save({
        version: 1,
        server: this.options.server ?? "",
        clientID: this.clientID,
        operations: [...this.#pending.values()].filter((item) =>
          active(item.state)
        ).map(({ state, principal }) => ({
          principal,
          ref: { ...state.ref },
          method: state.method,
          owner: state.owner,
          seq: state.seq,
          phase: state.phase,
        })),
      });
    } catch (cause) {
      this.options.diagnostic?.(cause);
    }
  }
  #publish(item: Pending): void {
    this.#save();
    for (const listener of new Set([...item.listeners, ...this.#listeners])) {
      try {
        listener();
      } catch (cause) {
        this.options.diagnostic?.(cause);
      }
    }
  }
  #send(frame: RequestControl): void {
    if (
      this.#stopped ||
      !this.#connected && frame.t !== "request.resume" &&
        !this.options.available?.(frame)
    ) {
      if (!this.#stopped) this.#defer(frame);
      return;
    }
    if (frame.t === "request") {
      const item = this.#pending.get(frame.ref.key);
      if (item && item.principal !== this.#principal) return;
      if (item) item.submitted = true;
    }
    try {
      this.options.send(frame);
    } catch (cause) {
      this.options.diagnostic?.(cause);
      this.disconnect();
      this.#defer(frame);
    }
  }
  #defer(frame: RequestControl): void {
    if (frame.t !== "request.release" && frame.t !== "request.received") return;
    for (const item of frame.refs) {
      const ref = "ref" in item ? item.ref : item;
      if (!ref.window) continue;
      const control: RequestControl = frame.t === "request.release"
        ? { t: "request.release", refs: [ref] }
        : {
          t: "request.received",
          refs: [item as { ref: RequestRef; seq: number }],
        };
      this.#controls.set(
        `${frame.t}:${ref.clientID}:${ref.window}:${ref.key}`,
        {
          control,
          principal: this.#pending.get(ref.key)?.principal ?? this.#principal,
        },
      );
    }
  }
  #create(
    state: OperationState,
    params?: unknown,
    canonical?: string,
  ): Pending {
    let resolve!: (value: unknown) => void, reject!: (cause: Error) => void;
    const result = new Promise<unknown>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Restored/background operations have no current promise consumer.
    void result.catch(() => {});
    const item: Pending = {
      principal: this.#principal,
      state,
      params,
      canonical,
      resolve,
      reject,
      settled: false,
      submitted: state.phase !== "sending",
      snapshot: false,
      listeners: new Set(),
      cleanup() {},
      operation: undefined!,
    };
    item.operation = {
      get state() {
        return item.state;
      },
      result,
      subscribe: (listener) => {
        item.listeners.add(listener);
        return () => item.listeners.delete(listener);
      },
      retry: () => {
        if (active(item.state)) {
          this.#send({
            t: "request.resume",
            items: [{ ref: item.state.ref, after: item.state.seq }],
          });
        }
      },
      release: () => {
        if (!active(item.state)) return;
        if (item.submitted) {
          this.#send({ t: "request.release", refs: [item.state.ref] });
        }
        if (
          item.submitted &&
          (this.options.kind?.(item.state.method) ?? "mutation") === "mutation"
        ) {
          item.cleanup();
          return;
        }
        item.state = { ...item.state, phase: "released" };
        if (!item.settled) {
          item.settled = true;
          item.reject(new RequestReleased());
        }
        item.cleanup();
        item.params = undefined;
        item.canonical = undefined;
        this.#publish(item);
      },
    };
    this.#pending.set(state.ref.key, item);
    return item;
  }
  start<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options: RequestOptions = {},
  ): Operation<RpcResult<M>> {
    return this.capture(method, params, options) as Operation<RpcResult<M>>;
  }
  /** Shared transport-neutral capture boundary, also used by HTTP bootstrap. */
  capture(
    method: string,
    params: unknown,
    options: RequestOptions = {},
  ): Operation<unknown> {
    const ref: RequestRef = {
      ...(options.intent ??
        {
          clientID: this.clientID,
          key: crypto.randomUUID(),
          window: this.#window?.id ?? "",
        }),
      id: crypto.randomUUID(),
    };
    if (!ref.window && this.#window) ref.window = this.#window.id;
    const canonical = canonicalRequest(params);
    const prior = this.#pending.get(ref.key);
    if (
      prior && prior.state.ref.clientID === ref.clientID &&
      prior.state.ref.window === ref.window && prior.state.method === method &&
      prior.canonical === canonical
    ) return prior.operation;
    if (prior) {
      const failure: PublicFailure = {
        code: "request.conflict",
        retry: "none",
        diagnosticID: crypto.randomUUID(),
      };
      const result = Promise.reject(new RequestFailure(failure));
      void result.catch(() => {});
      return {
        state: {
          ref,
          method,
          phase: "failed",
          connection: "connected",
          seq: 0,
          error: failure,
        },
        result,
        subscribe: () => () => {},
        retry() {},
        release() {},
      };
    }
    if (this.#stopped) throw new Error("Request tracker stopped");
    const item = this.#create(
      {
        ref,
        method,
        owner: options.owner,
        phase: "sending",
        connection: this.#connected ? "connected" : "reconnecting",
        seq: 0,
      },
      JSON.parse(canonical),
      canonical,
    );
    // Reservation precedes publication and transport, including synchronous receivers.
    const release = () => item.operation.release();
    options.signal?.addEventListener("abort", release, { once: true });
    item.cleanup = () => options.signal?.removeEventListener("abort", release);
    this.#save();
    if (options.signal?.aborted) item.operation.release();
    else this.#send({ t: "request", ref, method, params: item.params });
    this.#publish(item);
    return item.operation;
  }
  connect(
    window: RequestWindow,
    resumebatch: number,
    principal: string | undefined = this.#principal,
  ): void {
    if (this.#stopped) return;
    if (!Number.isSafeInteger(resumebatch) || resumebatch < 1) {
      throw new TypeError("Invalid resume batch");
    }
    this.#window = window;
    this.#batch = resumebatch;
    this.#connected = true;
    this.#principal = principal;
    for (const [key, queued] of [...this.#controls]) {
      if (queued.principal !== principal) continue;
      this.#controls.delete(key);
      this.#send(queued.control);
    }
    for (const item of this.#pending.values()) {
      if (item.state.ref.window === "") {
        item.principal = principal;
        item.state = {
          ...item.state,
          ref: { ...item.state.ref, window: window.id },
        };
      }
    }
    for (const item of this.#pending.values()) {
      if (active(item.state) && item.principal !== principal) {
        item.state = { ...item.state, connection: "authentication-required" };
        this.#publish(item);
      }
    }
    const pending = [...this.#pending.values()].filter((item) =>
      active(item.state) && item.principal === principal
    );
    for (const item of pending) {
      item.state = {
        ...item.state,
        ref: { ...item.state.ref, id: crypto.randomUUID() },
        connection: "connected",
      };
      this.#publish(item);
    }
    for (let index = 0; index < pending.length; index += this.#batch) {
      this.#send({
        t: "request.resume",
        items: pending.slice(index, index + this.#batch).map(({ state }) => ({
          ref: state.ref,
          after: state.seq,
        })),
      });
    }
  }
  disconnect(authentication = false): void {
    this.#connected = false;
    for (const item of this.#pending.values()) {
      if (active(item.state)) {
        item.state = {
          ...item.state,
          connection: authentication
            ? "authentication-required"
            : "reconnecting",
        };
        this.#publish(item);
      }
    }
  }
  receive(event: RequestEvent): void {
    if (this.#stopped) return;
    const item = this.#pending.get(event.ref.key);
    if (
      !item || item.state.ref.clientID !== event.ref.clientID ||
      item.principal !== this.#principal ||
      item.state.ref.window !== event.ref.window ||
      item.state.phase === "released"
    ) return;
    this.#connected = true;
    item.state = { ...item.state, connection: "connected" };
    if (event.t === "request.accepted") {
      item.submitted = true;
      if (item.settled || event.seq < item.state.seq) return;
      item.snapshot = event.replayed;
      item.state = {
        ...item.state,
        seq: event.seq,
        phase: item.state.phase === "sending" ? "queued" : item.state.phase,
      };
    } else if (event.t === "request.rejected") {
      if (item.settled) return;
      if (event.error.code === "request.receipt-reset") {
        item.state = {
          ...item.state,
          phase: "waiting",
          progress: { phase: "waiting", code: "input-required" },
        };
        this.#publish(item);
        return;
      }
      if (
        event.error.code === "request.input-required" &&
        event.error.retry === "same-intent"
      ) {
        item.state = {
          ...item.state,
          phase: "waiting",
          progress: { phase: "waiting", code: "input-required" },
        };
        if (item.params !== undefined) {
          this.#send({
            t: "request",
            ref: item.state.ref,
            method: item.state.method,
            params: item.params,
          });
        }
        this.#publish(item);
        return;
      }
      item.state = { ...item.state, phase: "failed", error: event.error };
      item.settled = true;
      item.reject(new RequestFailure(event.error));
      item.cleanup();
    } else {
      if (
        event.seq < item.state.seq ||
        event.seq === item.state.seq && !item.snapshot
      ) return;
      if (event.seq > item.state.seq + 1 && !item.snapshot) {
        item.operation.retry();
        return;
      }
      item.snapshot = false;
      item.state = { ...item.state, seq: event.seq };
      if (event.t === "request.progress") {
        item.state = {
          ...item.state,
          phase: event.progress.phase,
          progress: event.progress,
        };
        if (
          event.progress.code === "input-required" && item.params !== undefined
        ) {
          this.#send({
            t: "request",
            ref: item.state.ref,
            method: item.state.method,
            params: item.params,
          });
        }
      } else {
        item.state = {
          ...item.state,
          phase: event.outcome.ok ? "succeeded" : "failed",
          ...(event.outcome.ok ? {} : { error: event.outcome.error }),
        };
        if (!item.settled) {
          item.settled = true;
          if (event.outcome.ok) item.resolve(event.outcome.result);
          else item.reject(new RequestFailure(event.outcome.error));
        }
        item.cleanup();
        item.params = undefined;
        item.canonical = undefined;
        this.#send({
          t: "request.received",
          refs: [{ ref: item.state.ref, seq: event.seq }],
        });
      }
    }
    this.#publish(item);
    if (item.state.phase === "succeeded") this.#pending.delete(event.ref.key);
  }
  operations(owner?: string): Operation<unknown>[] {
    return [...this.#pending.values()].filter((item) =>
      owner === undefined || item.state.owner === owner
    ).map((item) => item.operation);
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  forgetFailures(owner: string, method: string): void {
    for (const [key, item] of this.#pending) {
      if (
        item.state.owner === owner && item.state.method === method &&
        item.state.phase === "failed"
      ) this.#pending.delete(key);
    }
  }
  intent(): IntentIdentity {
    return {
      clientID: this.clientID,
      key: crypto.randomUUID(),
      window: this.#window?.id ?? "",
    };
  }
  connectionFor(key: string, connection: OperationState["connection"]): void {
    const item = this.#pending.get(key);
    if (item && active(item.state)) {
      item.state = { ...item.state, connection };
      this.#publish(item);
    }
  }
  authenticationRequired(): void {
    this.#connected = false;
    for (const item of this.#pending.values()) {
      if (active(item.state)) {
        this.connectionFor(item.state.ref.key, "authentication-required");
      }
    }
  }
  stop(): void {
    this.disconnect();
    this.#stopped = true;
    for (const item of this.#pending.values()) item.cleanup();
  }
}

/** Child keys are allocated once and remain bound to their captured group. */
export class IntentGroup {
  #steps = new Map<string, IntentIdentity>();
  constructor(readonly identity: IntentIdentity) {}
  step(name: string): IntentIdentity {
    let step = this.#steps.get(name);
    if (!step) {
      step = { ...this.identity, key: crypto.randomUUID() };
      this.#steps.set(name, step);
    }
    return step;
  }
  options(name: string, owner?: string): RequestOptions {
    return { intent: this.step(name), owner };
  }
}

/** Reserve a composed intent before any preparation or deferred UI publication. */
export class IntentGroups {
  #pending = new Map<string, Promise<unknown>>();
  constructor(readonly identity: () => IntentIdentity) {}
  run<T>(key: string, action: (group: IntentGroup) => Promise<T>): Promise<T> {
    const prior = this.#pending.get(key);
    if (prior) return prior as Promise<T>;
    const deferred = Promise.withResolvers<T>();
    this.#pending.set(key, deferred.promise);
    void deferred.promise.catch(() => {});
    const group = new IntentGroup(this.identity());
    const finish = () => {
      if (this.#pending.get(key) === deferred.promise) {
        this.#pending.delete(key);
      }
    };
    try {
      void action(group).then((result) => {
        finish();
        deferred.resolve(result);
      }, (cause) => {
        finish();
        deferred.reject(cause);
      });
    } catch (cause) {
      finish();
      deferred.reject(cause);
    }
    return deferred.promise;
  }
}

export interface FormIntentState<T> {
  readonly pending: boolean;
  readonly key?: string;
  readonly captured?: T;
  readonly feedback?: Feedback;
}
export interface FormIntent<T, R> {
  readonly state: FormIntentState<T>;
  subscribe(listener: () => void): () => void;
  submit(value: T, run: (captured: T) => Promise<R>): Promise<R>;
}

export interface SubmissionIntent<T> {
  readonly state: FormIntentState<T>;
  subscribe(listener: () => void): () => void;
  submit(
    prepare: () => Promise<T | undefined>,
    run: (captured: T) => Promise<void>,
  ): Promise<void>;
}
/** Input preparation can finish while an admitted effect is still settling.
 * A subsequent input command gets its own preparation lifetime; another send
 * cannot replace or repeat the captured effect. */
export function createSubmissionIntent<T>(options: {
  capture(value: T): T;
  presenter: FailurePresenter;
  diagnostic?(id: string, cause: unknown): void;
}): SubmissionIntent<T> {
  const input = createFormIntent<void, { result: Promise<void> } | undefined>({
    ...options,
    capture: () => undefined,
  });
  const effect = createFormIntent<T, void>(options);
  return {
    get state() {
      return {
        ...effect.state,
        pending: input.state.pending || effect.state.pending,
        feedback: input.state.feedback ?? effect.state.feedback,
      };
    },
    subscribe(listener) {
      const first = input.subscribe(listener),
        second = effect.subscribe(listener);
      return () => {
        first();
        second();
      };
    },
    submit(prepare, run) {
      return input.submit(undefined, async () => {
        const value = await prepare();
        if (value === undefined || effect.state.pending) return;
        return { result: effect.submit(value, run) };
      }).then((admitted) => admitted?.result);
    },
  };
}
/** Form capture and duplicate admission are independent of native fields or view lifetime. */
export function createFormIntent<T, R>(options: {
  capture(value: T): T;
  presenter: FailurePresenter;
  diagnostic?(id: string, cause: unknown): void;
}): FormIntent<T, R> {
  let state: FormIntentState<T> = { pending: false },
    active: Promise<R> | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (cause) {
        try {
          options.diagnostic?.(crypto.randomUUID(), cause);
        } catch { /* Observer diagnostics cannot change the intent outcome. */ }
      }
    }
  };
  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit(value, run) {
      if (state.pending) return active!;
      const deferred = Promise.withResolvers<R>();
      active = deferred.promise;
      void active.catch(() => {});
      state = { pending: true, key: crypto.randomUUID() };
      let captured: T;
      const fail = (cause: unknown) => {
        state = {
          ...state,
          pending: false,
          feedback: failureFeedback(
            cause,
            options.presenter,
            options.diagnostic,
          ),
        };
        active = undefined;
        publish();
        deferred.reject(cause);
      };
      try {
        captured = options.capture(value);
      } catch (cause) {
        fail(cause);
        return deferred.promise;
      }
      state = { ...state, captured };
      publish();
      void Promise.resolve().then(() => run(captured)).then((result) => {
        state = { ...state, pending: false, feedback: undefined };
        active = undefined;
        publish();
        deferred.resolve(result);
      }, fail);
      return deferred.promise;
    },
  };
}
