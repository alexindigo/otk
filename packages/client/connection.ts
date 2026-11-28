// SPDX-License-Identifier: LGPL-3.0-only
import {
  clientRequestPolicyFrom,
  createRequestMetadata,
  messagePolicy,
  PROTOCOL_VERSION,
  welcomeCapabilities,
} from "@otk/protocol";
import type {
  CapabilityName,
  ClientFrame,
  ClientRequestPolicy,
  MessagePolicy,
  RequestControl,
  ServerFrame,
  ViewLease,
} from "@otk/protocol";
import { apiBase, type AuthStatus, bootstrapRequestMetadata } from "./auth.ts";
import { Rpc } from "./rpc.ts";
import { RequestTracker, type RequestTrackerOptions } from "./requests.ts";
import { HttpReadFailure, HttpRequests } from "./http-requests.ts";
import {
  type Feedback,
  FeedbackFailure,
  RequestFailure,
  RequestReleased,
} from "./failures.ts";
import { type PublicDefaults, publicDefaultsFrom } from "./public-defaults.ts";
import { authStatus, discoveryFailure } from "./discovery.ts";
import { actionFeedback } from "./failure-features.ts";
import { RequestLifetimes } from "./request-lifetime.ts";
import type { SidecarState } from "./sidecars.ts";
import { ReloadRefused } from "./reload.ts";
import {
  type ContinuityMemory,
  graceElapsed,
  lost,
  outdated,
  reached,
  refused,
  type ServerContinuity,
  UNREACHABLE_GRACE_MS,
  welcomed,
} from "./server-continuity.ts";

export type ConnectionInput = Pick<
  SidecarState,
  "label" | "status" | "harness" | "error" | "feedback" | "continuity"
>;
export type ConnectionLightState =
  | "updated"
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected"
  | "error";
/** Both links must be healthy. Session work/attention never enters this owner. */
export function connectionState(
  connection?: ConnectionInput,
): ConnectionLightState {
  if (!connection) return "disconnected";
  if (
    connection.continuity?.kind === "updated" ||
    connection.status === "client outdated" ||
    connection.status === "protocol mismatch"
  ) return "updated";
  if (
    connection.error || connection.status === "login required" ||
    connection.status === "setup required"
  ) return "error";
  if (
    connection.status === "reconnecting" ||
    connection.harness === "reconnecting"
  ) return "reconnecting";
  if (connection.status === "connected" && connection.harness === "connected") {
    return "connected";
  }
  return "connecting";
}

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "login required"
  | "setup required"
  | "client outdated"
  | "protocol mismatch";
export interface ConnectionSink {
  defaults?(value: PublicDefaults): void;
  continuity?(state: ServerContinuity): void;
  status(
    state: ConnectionState,
    error?: string,
    authType?: string,
    feedback?: Feedback,
  ): void;
  frame(frame: ServerFrame): boolean | void;
}
export interface ConnectionOptions {
  retireRequestDisclosures?(scope: string): void;
  /** Application-owned lossless reload; the transport never reloads the page. */
  reload?(): void | Promise<void>;
  page?: { build?: string };
  graceMs?: number;
  /** Application-supplied policy before this server returns its own authority. */
  policy?: ClientRequestPolicy;
  /** UI adapters acknowledge accepted state after its render opportunity. */
  afterRender?(accepted: () => void): void;
  attachments?: import("@otk/protocol").AttachmentPolicy;
  messages?: MessagePolicy;
  api?: URL;
  socket?: (url: URL) => WebSocket;
  fetcher?: typeof fetch;
  requests?: Omit<
    RequestTrackerOptions,
    "send" | "server" | "available" | "renewWindow"
  >;
}
export type ConnectionAttempt =
  | { kind: "checked"; auth: AuthStatus }
  | { kind: "failed"; cause: unknown }
  | { kind: "superseded" };
export type RecoveredConnection = {
  instance: string;
  replaced: boolean;
};
function browserStorage(server: string): RequestTrackerOptions["storage"] {
  if (
    typeof globalThis.document === "undefined" ||
    typeof globalThis.sessionStorage === "undefined"
  ) return;
  const key = `otk.requests.v1:${server}`;
  return {
    load: () => {
      const value = sessionStorage.getItem(key);
      return value ? JSON.parse(value) : undefined;
    },
    save: (value) => sessionStorage.setItem(key, JSON.stringify(value)),
  };
}
export class SidecarConnection {
  readonly base: URL;
  readonly attention: RequestLifetimes;
  readPermissions(
    scope: string,
    entry: import("@otk/protocol").SessionLookup,
    signal?: AbortSignal,
  ): Promise<import("@otk/protocol").PermissionRequest[]> {
    return this.attention.readPermissions(
      scope,
      entry,
      (owned) =>
        this.supports("permissions")
          ? this.rpc.call("permission.list", { sessionID: scope }, owned)
          : Promise.resolve([]),
      this.messages,
      signal,
    );
  }
  readonly rpc: Rpc;
  readonly requests: RequestTracker;
  readonly http: HttpRequests;
  #socket?: WebSocket;
  #controller?: AbortController;
  #retry?: ReturnType<typeof setTimeout>;
  #silence?: ReturnType<typeof setTimeout>;
  #grace?: ReturnType<typeof setTimeout>;
  #continuity: ServerContinuity = { kind: "away", since: Date.now() };
  #memory: ContinuityMemory;
  #attempt = 0;
  #invalidFailure?: string;
  #policy?: ClientRequestPolicy;
  #stopped = false;
  #welcomed = false;
  #subscriptions = new Set<string>();
  #capabilities = new Set<CapabilityName>();
  #messages?: MessagePolicy;
  #attachments?: import("@otk/protocol").AttachmentPolicy;
  #auth?: AuthStatus;
  #view: ViewLease = { epoch: 0, crumbs: [], rows: [] };
  #selectionGeneration = 0;
  #page: "waiting" | "accepted" | "settled" = "waiting";
  #attachment?: {
    sentEpoch: number;
    baseline: boolean;
    acknowledgedEpoch?: number;
    confirmsViews?: true;
    recovered: boolean;
    welcome?: {
      state: ServerContinuity;
      memory: ContinuityMemory;
      connection: RecoveredConnection;
    };
  };
  #recoveredListeners = new Set<(connection: RecoveredConnection) => void>();
  onRecovered(listener: (connection: RecoveredConnection) => void): () => void {
    this.#recoveredListeners.add(listener);
    return () => this.#recoveredListeners.delete(listener);
  }
  /** Capture selection and transport generations before acquiring its first page. */
  firstPage(sessionID: string): () => void {
    if (this.#page !== "waiting" || this.#view.selected !== sessionID) {
      return () => {};
    }
    const generation = this.#selectionGeneration, controller = this.#controller;
    return () => {
      const accepted = () => {
        if (
          generation !== this.#selectionGeneration ||
          controller !== this.#controller ||
          this.#view.selected !== sessionID || this.#page !== "waiting"
        ) return;
        this.#page = "accepted";
        this.#settlePage();
      };
      if (this.options.afterRender) this.options.afterRender(accepted);
      else queueMicrotask(accepted);
    };
  }
  #settlePage(): void {
    const attachment = this.#attachment, { epoch, selected } = this.#view;
    if (
      this.#page !== "accepted" || !selected || !attachment ||
      !this.connected ||
      (attachment.confirmsViews && attachment.acknowledgedEpoch !== epoch)
    ) return;
    this.#page = "settled";
    this.send({ t: "view.settled", epoch, sessionID: selected });
  }
  get viewEpoch(): number {
    return this.#view.epoch;
  }
  /** Last-good resources do not imply a currently welcomed live transport. */
  get connected(): boolean {
    return this.#welcomed && this.#socket?.readyState === WebSocket.OPEN;
  }
  /** Retain demand across reconnects, independently of request admission. */
  view(value: Omit<ViewLease, "epoch">): void {
    if (
      JSON.stringify({ ...this.#view, epoch: undefined }) ===
        JSON.stringify({ ...value, epoch: undefined })
    ) return;
    if (value.selected !== this.#view.selected) {
      this.#selectionGeneration++;
      this.#page = "waiting";
    }
    this.#view = {
      ...value,
      crumbs: [...value.crumbs],
      rows: [...value.rows],
      references: value.references?.slice(),
      epoch: this.#view.epoch + 1,
    };
    this.#reconcileView();
  }
  #reconcileView(): void {
    const attachment = this.#attachment;
    if (
      !this.connected || !attachment ||
      attachment.sentEpoch === this.#view.epoch
    ) return;
    attachment.sentEpoch = this.#view.epoch;
    this.send({ t: "view", ...this.#view });
    // An overtaken hello can only have published a baseline for the old
    // epoch. A patch cannot initialize a replacement socket's index replica.
    if (attachment.confirmsViews && !attachment.baseline) {
      this.send({ t: "resnapshot" });
    }
  }
  #recover(): void {
    const attachment = this.#attachment, welcome = attachment?.welcome;
    if (
      !attachment || !welcome || attachment.recovered ||
      (attachment.confirmsViews &&
        (!attachment.baseline ||
          attachment.acknowledgedEpoch !== this.#view.epoch))
    ) return;
    attachment.recovered = true;
    this.#clearGrace();
    this.#attempt = 0;
    this.#memory = welcome.memory;
    this.#publish(welcome.state);
    if (this.#attachment !== attachment) return;
    this.sink.status("connected");
    for (const listener of this.#recoveredListeners) {
      if (this.#attachment !== attachment) break;
      listener(welcome.connection);
    }
  }
  get attachments(): import("@otk/protocol").AttachmentPolicy | undefined {
    return this.#attachments ?? this.options.attachments;
  }
  get messages(): MessagePolicy | undefined {
    return this.#messages ?? this.options.messages;
  }
  constructor(
    baseUrl: string,
    readonly sink: ConnectionSink,
    readonly options: ConnectionOptions = {},
  ) {
    this.base = options.api ?? apiBase(baseUrl);
    this.attention = new RequestLifetimes(
      undefined,
      options.retireRequestDisclosures,
    );
    this.#memory = { page: options.page };
    this.#policy = options.policy && clientRequestPolicyFrom(options.policy);
    const metadata = createRequestMetadata();
    this.requests = new RequestTracker({
      ...options.requests,
      server: this.base.href,
      storage: options.requests?.storage ?? browserStorage(this.base.href),
      kind: options.requests?.kind ??
        ((method) =>
          metadata.get(method)?.kind ??
            bootstrapRequestMetadata[method]?.kind ??
            "mutation"),
      available: (control) => this.#welcomed || this.#bootstrap(control),
      renewWindow: () => {
        this.#retire();
        this.#schedule();
      },
      send: (control) => this.#route(control),
    });
    this.rpc = new Rpc((frame) => this.send(frame), this.requests);
    this.http = new HttpRequests({
      base: this.base,
      tracker: this.requests,
      fetcher: options.fetcher,
      policy: this.#policy,
    });
    this.sink.continuity?.(this.#continuity);
    this.#startGrace();
  }
  #bootstrap(control: RequestControl): boolean {
    if (control.t === "request") return control.ref.window === "bootstrap";
    const items = control.t === "request.resume" ? control.items : control.refs;
    return items.some((item) =>
      ("ref" in item ? item.ref : item).window === "bootstrap"
    );
  }
  #route(control: RequestControl): void {
    if (control.t === "request") {
      if (control.ref.window === "bootstrap") this.http.send(control);
      else this.send(control);
      return;
    }
    if (control.t === "request.resume") {
      const http = control.items.filter(({ ref }) =>
          ref.window === "bootstrap"
        ),
        ws = control.items.filter(({ ref }) => ref.window !== "bootstrap");
      if (http.length) this.http.send({ ...control, items: http });
      if (ws.length) this.send({ ...control, items: ws });
    } else if (control.t === "request.release") {
      const http = control.refs.filter((ref) => ref.window === "bootstrap"),
        ws = control.refs.filter((ref) => ref.window !== "bootstrap");
      if (http.length) this.http.send({ ...control, refs: http });
      if (ws.length) this.send({ ...control, refs: ws });
    } else {
      const http = control.refs.filter(({ ref }) => ref.window === "bootstrap"),
        ws = control.refs.filter(({ ref }) => ref.window !== "bootstrap");
      if (http.length) this.http.send({ ...control, refs: http });
      if (ws.length) this.send({ ...control, refs: ws });
    }
  }
  send(frame: ClientFrame): void {
    if (!this.#welcomed || this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Sidecar is not connected");
    }
    this.#socket.send(JSON.stringify(frame));
  }
  supports(capability: CapabilityName): boolean {
    return this.#welcomed && this.#capabilities.has(capability);
  }
  subscribe(sessionID: string, enabled: boolean): void {
    if (enabled) this.#subscriptions.add(sessionID);
    else this.#subscriptions.delete(sessionID);
    if (this.#welcomed) {
      this.send({ t: enabled ? "subscribe" : "unsubscribe", sessionID });
    }
  }
  async connect(discovered?: AuthStatus): Promise<ConnectionAttempt> {
    if (this.#stopped) return { kind: "superseded" };
    this.#retire();
    const controller = this.#controller = new AbortController();
    const current = () =>
      this.#controller === controller && !controller.signal.aborted &&
      !this.#stopped;
    this.sink.status(this.#attempt === 0 ? "connecting" : "reconnecting");
    try {
      const auth = authStatus(
        discovered ?? await this.http.read<AuthStatus>("session", {
          signal: controller.signal,
          owner: "connection",
        }),
        this.base.href,
      );
      if (!current()) return { kind: "superseded" };
      this.#invalidFailure = undefined;
      this.#auth = auth;
      const defaults = publicDefaultsFrom(auth.defaults);
      if (defaults) this.sink.defaults?.(defaults);
      this.#policy = clientRequestPolicyFrom(auth.requests.policy);
      this.http.policy(this.#policy);
      if (auth.setupRequired || !auth.authenticated) {
        this.#clearGrace();
        this.#publish(reached(this.#continuity));
        this.requests.authenticationRequired();
        this.sink.status(
          auth.setupRequired ? "setup required" : "login required",
          undefined,
          auth.authType,
        );
        return { kind: "checked", auth: this.#auth };
      }
      const url = new URL("ws", this.base);
      url.protocol =
        globalThis.location?.protocol === "https:" || url.protocol === "https:"
          ? "wss:"
          : "ws:";
      const socket = this.#socket = this.options.socket?.(url) ??
        new WebSocket(url);
      socket.onopen = () => {
        if (current() && socket === this.#socket) {
          this.#attachment = {
            sentEpoch: this.#view.epoch,
            baseline: false,
            recovered: false,
          };
          socket.send(
            JSON.stringify({
              t: "hello",
              protocol: PROTOCOL_VERSION,
              view: this.#view,
            }),
          );
        }
      };
      socket.onmessage = ({ data }) => {
        const attachment = this.#attachment;
        if (!current() || socket !== this.#socket || !attachment) return;
        const frame: ServerFrame = JSON.parse(data);
        // Inbox patches and settlement edges have their own revision fences
        // across view changes. In particular an in-flight settlement must not
        // be lost when a new view replaces the one that observed the work.
        if (
          frame.t !== "load.chunk" && frame.t !== "inbox.patch" &&
          frame.t !== "inbox.settlement" &&
          frame.epoch !== undefined &&
          frame.epoch < this.#view.epoch
        ) return;
        if (this.#policy) {
          clearTimeout(this.#silence);
          this.#silence = setTimeout(() => {
            if (current()) {
              this.#retire();
              this.#schedule();
            }
          }, this.#policy.silencems);
        }
        if (frame.t === "ping") {
          socket.send(JSON.stringify({ t: "pong" }));
          return;
        }
        if (frame.t === "welcome") {
          if (this.#welcomed) return;
          const facts = {
            protocol: frame.protocol,
            build: frame.sidecar?.build,
          };
          if (frame.protocol !== PROTOCOL_VERSION) {
            this.#protocolMismatch(facts);
            return;
          }
          try {
            this.#messages = messagePolicy(frame.messages);
            this.#attachments = frame.attachments;
            this.#policy = clientRequestPolicyFrom(frame.requests.policy);
          } catch {
            this.#protocolMismatch(facts);
            return;
          }
          const result = welcomed(this.#continuity, this.#memory, {
            build: frame.sidecar.build,
            instance: frame.sidecar.instance,
          });
          attachment.welcome = {
            ...result,
            connection: {
              instance: frame.sidecar.instance,
              replaced: this.#memory.current?.instance !== undefined &&
                this.#memory.current.instance !== frame.sidecar.instance,
            },
          };
          attachment.confirmsViews = frame.viewAcknowledgements;
          if (result.state.kind === "updated") this.#publish(result.state);
          if (!current()) return;
          this.#welcomed = true;
          this.#capabilities = new Set(welcomeCapabilities(frame));
          this.http.policy(this.#policy);
          this.#reconcileView();
          for (const id of this.#subscriptions) {
            this.send({ t: "subscribe", sessionID: id });
          }
          this.requests.connect(
            frame.requests.window,
            this.#policy.resumebatch,
            frame.requests.principal,
          );
          if (!current()) return;
          if (!attachment.confirmsViews) this.#recover();
          this.#settlePage();
        }
        if (frame.t === "error" && frame.code === "protocol") {
          this.#protocolMismatch({
            protocol: frame.protocol,
            build: frame.build,
          });
          return;
        }
        if (!this.#welcomed) return;
        if (frame.t === "view.ready") {
          if (frame.epoch === attachment.sentEpoch) {
            attachment.acknowledgedEpoch = frame.epoch;
            this.#settlePage();
            this.#recover();
          }
          return;
        }
        if (
          attachment.confirmsViews && !attachment.baseline &&
          frame.t === "index.patch"
        ) return;
        this.rpc.receive(frame);
        if (frame.t === "harness" && frame.state !== "connected") {
          this.attention.resetPermissionScopes();
        }
        const accepted = this.sink.frame(frame);
        if (!current() || socket !== this.#socket) return;
        if (
          accepted !== false && frame.epoch !== undefined &&
          (frame.t === "index.snapshot" || frame.t === "index.patch")
        ) {
          this.send({ t: "index.applied", epoch: frame.epoch, rev: frame.rev });
          if (frame.t === "index.snapshot") {
            attachment.baseline = true;
            this.#recover();
          }
        }
      };
      socket.onclose = () => {
        if (current() && socket === this.#socket) {
          this.#retire();
          this.#schedule();
        }
      };
      return { kind: "checked", auth: this.#auth };
    } catch (cause) {
      if (current() && !(cause instanceof RequestReleased)) {
        const invalid =
          cause instanceof HttpReadFailure && cause.kind === "invalid" ||
          cause instanceof FeedbackFailure;
        const feedback = !invalid && !(cause instanceof RequestFailure)
          ? undefined
          : actionFeedback(
            cause instanceof FeedbackFailure || cause instanceof RequestFailure
              ? cause
              : discoveryFailure(
                this.base.href,
                cause instanceof HttpReadFailure
                  ? cause.reason
                  : "the browser could not open the OTK connection",
                "Check that the server and this page run matching OTK versions",
              ),
          );
        const failure = feedback?.text;
        // A fresh connection must confirm malformed data before it becomes an
        // error. Readiness, transport gaps and reset volatile receipts never do.
        const persistent = invalid && failure !== undefined &&
          failure === this.#invalidFailure;
        this.#invalidFailure = invalid ? failure : undefined;
        this.#retire();
        this.#schedule(
          cause instanceof HttpReadFailure ? cause.retryAfter : undefined,
          persistent || cause instanceof RequestFailure ? feedback : undefined,
        );
        return { kind: "failed", cause };
      }
      return { kind: "superseded" };
    }
  }
  #schedule(retryAfter = 0, feedback?: Feedback): void {
    if (this.#stopped) return;
    this.#publish(lost(this.#continuity, Date.now()));
    this.#startGrace();
    const attempt = this.#attempt++;
    if (this.#policy) {
      this.#retry = setTimeout(
        () => void this.connect(),
        Math.max(
          retryAfter,
          Math.min(
            this.#policy.retrybase * 2 ** Math.min(attempt, 30),
            this.#policy.retrymax,
          ),
        ),
      );
    }
    this.sink.status("reconnecting", feedback?.text, undefined, feedback);
  }
  #publish(next: ServerContinuity): void {
    if (next === this.#continuity) return;
    this.#continuity = next;
    this.sink.continuity?.(next);
  }
  #startGrace(): void {
    if (this.#continuity.kind !== "away" || this.#grace !== undefined) return;
    this.#grace = setTimeout(() => {
      this.#grace = undefined;
      this.#publish(graceElapsed(this.#continuity));
    }, this.options.graceMs ?? UNREACHABLE_GRACE_MS);
  }
  #clearGrace(): void {
    clearTimeout(this.#grace);
    this.#grace = undefined;
  }
  #retire(): void {
    this.#selectionGeneration++;
    this.#page = "waiting";
    this.#attachment = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    clearTimeout(this.#retry);
    clearTimeout(this.#silence);
    this.#retry = undefined;
    this.#welcomed = false;
    this.attention.resetPermissionScopes();
    this.requests.disconnect();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
  }
  #protocolMismatch(facts: { protocol?: number; build?: string }): void {
    // Retire transport, not captured mutation/input custody. Reload owns that.
    this.#stopped = true;
    this.#retire();
    this.requests.clientOutdated();
    this.#clearGrace();
    this.#publish(outdated(this.#continuity, facts));
    this.sink.status("client outdated");
  }
  async reload(): Promise<void> {
    if (!this.options.reload) return;
    this.#publish(refused(this.#continuity));
    try {
      await this.options.reload();
    } catch (cause) {
      console.error("Reload checkpoint diagnostic", cause);
      this.#publish(refused(
        this.#continuity,
        cause instanceof ReloadRefused
          ? cause.message
          : "Your work could not be saved for Reload. This page has not reloaded.",
      ));
    }
  }
  async login(input: { username: string; password: string }): Promise<void> {
    await this.http.start("login", input, { owner: "login" }).result;
    const attempt = await this.connect();
    if (attempt.kind === "failed") throw attempt.cause;
    if (attempt.kind === "superseded") return;
    if (!attempt.auth.authenticated && !attempt.auth.setupRequired) {
      const failure = discoveryFailure(
        this.base.href,
        "OTK accepted sign-in, but this page is still not authenticated",
        "Open that server's OTK page and check browser cookie settings before signing in again",
      );
      // A reconnect remounts the login form. The connection owns this result.
      this.sink.status(
        "login required",
        actionFeedback(failure)?.text,
        attempt.auth.authType,
        actionFeedback(failure),
      );
      throw failure;
    }
  }
  async setup(
    input: { type: string; username: string; password: string },
  ): Promise<void> {
    await this.http.start("setup", input, { owner: "setup" }).result;
    const attempt = await this.connect();
    if (attempt.kind === "failed") throw attempt.cause;
  }
  stop(): void {
    this.#stopped = true;
    this.#clearGrace();
    this.#retire();
    this.#subscriptions.clear();
    this.#recoveredListeners.clear();
    this.requests.stop();
    void this.http.stop();
  }
}
