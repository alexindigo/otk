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
} from "@otk/protocol";
import { apiBase, type AuthStatus, bootstrapRequestMetadata } from "./auth.ts";
import { Rpc } from "./rpc.ts";
import { RequestTracker, type RequestTrackerOptions } from "./requests.ts";
import { HttpRequests } from "./http-requests.ts";
import { RequestReleased } from "./failures.ts";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "login required"
  | "setup required"
  | "protocol mismatch";
export interface ConnectionSink {
  status(state: ConnectionState, error?: string, authType?: string): void;
  frame(frame: ServerFrame): void;
}
export interface ConnectionOptions {
  messages?: MessagePolicy;
  api?: URL;
  socket?: (url: URL) => WebSocket;
  fetcher?: typeof fetch;
  requests?: Omit<RequestTrackerOptions, "send" | "server" | "available">;
}
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
  readonly rpc: Rpc;
  readonly requests: RequestTracker;
  readonly http: HttpRequests;
  #socket?: WebSocket;
  #controller?: AbortController;
  #retry?: ReturnType<typeof setTimeout>;
  #silence?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #policy?: ClientRequestPolicy;
  #stopped = false;
  #welcomed = false;
  #subscriptions = new Set<string>();
  #capabilities = new Set<CapabilityName>();
  #messages?: MessagePolicy;
  get messages(): MessagePolicy | undefined {
    return this.#messages ?? this.options.messages;
  }
  constructor(
    baseUrl: string,
    readonly sink: ConnectionSink,
    readonly options: ConnectionOptions = {},
  ) {
    this.base = options.api ?? apiBase(baseUrl);
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
      send: (control) => this.#route(control),
    });
    this.rpc = new Rpc((frame) => this.send(frame), this.requests);
    this.http = new HttpRequests({
      base: this.base,
      tracker: this.requests,
      fetcher: options.fetcher,
    });
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
  async connect(): Promise<void> {
    if (this.#stopped) return;
    this.#retire();
    const controller = this.#controller = new AbortController();
    const current = () =>
      this.#controller === controller && !controller.signal.aborted &&
      !this.#stopped;
    this.sink.status(this.#attempt === 0 ? "connecting" : "reconnecting");
    try {
      const auth = await this.http.start<AuthStatus>("session", undefined, {
        signal: controller.signal,
        owner: "connection",
      }).result;
      if (!current()) return;
      this.#policy = clientRequestPolicyFrom(auth.requests.policy);
      this.http.policy(this.#policy);
      if (auth.setupRequired || !auth.authenticated) {
        this.requests.authenticationRequired();
        this.sink.status(
          auth.setupRequired ? "setup required" : "login required",
          undefined,
          auth.authType,
        );
        return;
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
          socket.send(
            JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }),
          );
        }
      };
      socket.onmessage = ({ data }) => {
        if (!current() || socket !== this.#socket) return;
        const frame: ServerFrame = JSON.parse(data);
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
          if (frame.protocol !== PROTOCOL_VERSION) {
            this.#protocolMismatch();
            return;
          }
          try {
            this.#messages = messagePolicy(frame.messages);
            this.#policy = clientRequestPolicyFrom(frame.requests.policy);
          } catch {
            this.#protocolMismatch();
            return;
          }
          this.#welcomed = true;
          this.#capabilities = new Set(welcomeCapabilities(frame));
          this.#attempt = 0;
          this.http.policy(this.#policy);
          for (const id of this.#subscriptions) {
            this.send({ t: "subscribe", sessionID: id });
          }
          this.requests.connect(
            frame.requests.window,
            this.#policy.resumebatch,
            frame.requests.principal,
          );
          this.sink.status("connected");
        }
        if (frame.t === "error" && frame.code === "protocol") {
          this.#protocolMismatch();
          return;
        }
        this.rpc.receive(frame);
        this.sink.frame(frame);
      };
      socket.onclose = () => {
        if (current() && socket === this.#socket) {
          this.#retire();
          this.#schedule();
        }
      };
    } catch (cause) {
      if (current() && !(cause instanceof RequestReleased)) {
        this.#retire();
        this.#schedule();
      }
    }
  }
  #schedule(): void {
    if (this.#stopped) return;
    const attempt = this.#attempt++;
    if (this.#policy) {
      this.#retry = setTimeout(
        () => void this.connect(),
        Math.min(
          this.#policy.retrybase * 2 ** Math.min(attempt, 30),
          this.#policy.retrymax,
        ),
      );
    }
    this.sink.status("reconnecting");
  }
  #retire(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    clearTimeout(this.#retry);
    clearTimeout(this.#silence);
    this.#retry = undefined;
    this.#welcomed = false;
    this.requests.disconnect();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
  }
  #protocolMismatch(): void {
    this.stop();
    this.sink.status(
      "protocol mismatch",
      "Reload after updating the client and sidecar together.",
    );
  }
  async login(input: { username: string; password: string }): Promise<void> {
    await this.http.start("login", input, { owner: "login" }).result;
    await this.connect();
  }
  async setup(
    input: { type: string; username: string; password: string },
  ): Promise<void> {
    await this.http.start("setup", input, { owner: "setup" }).result;
    await this.connect();
  }
  stop(): void {
    this.#stopped = true;
    this.#retire();
    this.#subscriptions.clear();
    this.requests.stop();
    void this.http.stop();
  }
}
