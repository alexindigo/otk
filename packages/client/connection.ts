// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import type { CapabilityName, ClientFrame, ServerFrame } from "@otk/protocol";
import { PROTOCOL_VERSION, welcomeCapabilities } from "@otk/protocol";
import { apiBase, type AuthStatus, request } from "./auth.ts";
import { Rpc } from "./rpc.ts";

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
/** Non-browser callers inject their authenticated/Origin-aware transport. */
export interface ConnectionOptions {
  api?: URL;
  socket?: (url: URL) => WebSocket;
}
export class SidecarConnection {
  readonly base: URL;
  readonly rpc: Rpc;
  #socket?: WebSocket;
  #controller?: AbortController;
  #retry?: ReturnType<typeof setTimeout>;
  #backoff = 1000;
  #stopped = false;
  #welcomed = false;
  #subscriptions = new Set<string>();
  #capabilities = new Set<CapabilityName>();
  constructor(
    baseUrl: string,
    readonly sink: ConnectionSink,
    readonly options: ConnectionOptions = {},
  ) {
    this.base = options.api ?? apiBase(baseUrl);
    this.rpc = new Rpc((frame) => this.send(frame));
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
    // Removal/unmount ends this instance's lifetime; late async callers cannot
    // restart it. Reconnects use a live instance, re-adds create a new one.
    if (this.#stopped) return;
    this.#retire();
    const controller = this.#controller = new AbortController();
    const current = () =>
      this.#controller === controller && !controller.signal.aborted &&
      !this.#stopped;
    this.sink.status(this.#backoff === 1000 ? "connecting" : "reconnecting");
    try {
      if (!current()) return;
      const auth = await request<AuthStatus>(
        this.base,
        "session",
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (!current()) return;
      if (auth.setupRequired || !auth.authenticated) {
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
        if (frame.t === "ping") {
          socket.send(JSON.stringify({ t: "pong" }));
          return;
        }
        if (frame.t === "welcome") {
          if (frame.protocol !== PROTOCOL_VERSION) {
            this.#protocolMismatch();
            return;
          }
          this.#welcomed = true;
          this.#capabilities = new Set(welcomeCapabilities(frame));
          this.#backoff = 1000;
          this.sink.status("connected");
          if (!current()) return;
          for (const sessionID of this.#subscriptions) {
            this.send({ t: "subscribe", sessionID });
          }
        }
        if (frame.t === "error" && frame.code === "protocol") {
          this.#protocolMismatch();
          return;
        }
        this.rpc.receive(frame);
        this.sink.frame(frame);
      };
      socket.onclose = () => {
        if (!current() || socket !== this.#socket) return;
        this.#retire();
        if (!this.#stopped) this.#schedule();
      };
    } catch (error) {
      if (current()) {
        this.#retire();
        this.#schedule(errorMessage(error));
      }
    }
  }
  #schedule(error?: string): void {
    if (this.#stopped) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, 30_000);
    this.#retry = setTimeout(() => void this.connect(), delay);
    this.sink.status("reconnecting", error);
  }
  #retire(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#welcomed = false;
    this.#capabilities.clear();
    this.rpc.close();
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
    await request(this.base, "login", input);
    await this.connect();
  }
  async setup(
    input: { type: string; username: string; password: string },
  ): Promise<void> {
    await request(this.base, "setup", input);
    await this.connect();
  }
  stop(): void {
    this.#stopped = true;
    this.#retire();
    this.#subscriptions.clear();
  }
}
