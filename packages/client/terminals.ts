// SPDX-License-Identifier: LGPL-3.0-only
import type { TerminalInfo } from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
import { type FailureValue, failureValue } from "./failure-features.ts";
import { createState, type StateFactory } from "./state.ts";

export interface TerminalMeta {
  title?: string;
  foreground?: string | null;
  role?: string;
  status?: "running" | "exited";
  exited?: number | null;
  connected?: boolean;
}
export interface TerminalSink {
  reset(cols: number, rows: number, checkpoint: Uint8Array): void;
  /** A live size change retains both screens and local scrollback. */
  resize(cols: number, rows: number): void;
  write(bytes: Uint8Array): void;
  meta(change: TerminalMeta): void;
}
export interface TerminalAttachment {
  readonly retained: boolean;
  input(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Explicit tab selection retries a channel left disconnected by lag. */
  reconnect(): void;
  close(): void;
}
export interface TerminalClock {
  now(): number;
  schedule(run: () => void, ms: number): () => void;
}
interface Channel {
  session: string;
  terminal: string;
  sink: TerminalSink;
  ch?: number;
  ready: boolean;
  blocked: boolean;
  lastLag?: number;
  size?: { cols: number; rows: number };
}
export type TerminalSocketEvent =
  | { kind: "refresh"; session?: string }
  | {
    kind: "connection";
    session: string;
    terminal: string;
    connected: boolean;
  };

/** One lazy terminal transport per sidecar, shared by its session owners. */
export class TerminalSocket {
  #socket?: WebSocket;
  #channels = new Set<Channel>();
  #wire = new Map<number, Channel>();
  #listeners = new Set<(event: TerminalSocketEvent) => void>();
  #next = 1;
  #attempt = 0;
  #retry?: () => void;
  #idle?: () => void;
  #liveness?: () => void;
  #lastFrame = 0;
  #stopped = false;
  #clock: TerminalClock;
  constructor(
    private conn: Pick<SidecarConnection, "base" | "options">,
    clock?: TerminalClock,
  ) {
    this.#clock = clock ?? {
      now: () => Date.now(),
      schedule: (run, ms) => {
        const timer = globalThis.setTimeout(run, ms);
        return () => globalThis.clearTimeout(timer);
      },
    };
  }
  subscribe(listener: (event: TerminalSocketEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event: TerminalSocketEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
  #connected(channel: Channel, connected: boolean): void {
    channel.sink.meta({ connected });
    this.#emit({
      kind: "connection",
      session: channel.session,
      terminal: channel.terminal,
      connected,
    });
  }
  attach(
    session: string,
    terminal: string,
    sink: TerminalSink,
  ): TerminalAttachment {
    if (this.#stopped) throw new Error("Terminal socket is stopped");
    const channel: Channel = {
      session,
      terminal,
      sink,
      ready: false,
      blocked: false,
    };
    this.#channels.add(channel);
    this.#wake();
    this.#connected(channel, false);
    if (this.#socket?.readyState === WebSocket.OPEN) this.#bind(channel);
    else this.#connect();
    const channels = this.#channels;
    return {
      get retained() {
        return channels.has(channel);
      },
      input: (bytes) => {
        if (!channel.ready || channel.ch === undefined) return;
        // The mux's 64 KiB limit includes the four-byte prefix, not just input.
        for (let at = 0; at < bytes.length; at += 65532) {
          const chunk = bytes.subarray(at, at + 65532);
          const frame = new Uint8Array(4 + chunk.length);
          new DataView(frame.buffer).setUint32(0, channel.ch, false);
          frame.set(chunk, 4);
          this.#socket?.send(frame);
        }
      },
      resize: (cols, rows) => {
        if (
          !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 ||
          rows < 1 || cols > 65535 || rows > 65535
        ) {
          throw new RangeError("Expected terminal size in cells");
        }
        channel.size = { cols, rows };
        if (channel.ready && channel.ch !== undefined) {
          this.#send({ t: "resize", ch: channel.ch, cols, rows });
        }
      },
      reconnect: () => {
        if (!this.#channels.has(channel) || channel.ch !== undefined) return;
        channel.blocked = false;
        channel.lastLag = undefined;
        this.#wake();
        if (this.#socket?.readyState === WebSocket.OPEN) this.#bind(channel);
        else this.#connect();
      },
      close: () => this.#drop(channel),
    };
  }
  #send(message: object): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }
  #wake(): void {
    // An idle transport has no liveness lease. Reacquisition starts its own
    // deadline; time spent with no interested channels is not a missed frame.
    if (this.#idle !== undefined) this.#lastFrame = this.#clock.now();
    this.#idle?.();
    this.#idle = undefined;
  }
  #bind(channel: Channel): void {
    channel.ch = this.#next++;
    channel.ready = false;
    this.#wire.set(channel.ch, channel);
    this.#send({
      t: "attach",
      ch: channel.ch,
      session: channel.session,
      terminal: channel.terminal,
    });
    this.#watch();
  }
  #unbind(channel: Channel): void {
    if (channel.ch !== undefined) {
      this.#send({ t: "detach", ch: channel.ch });
      this.#wire.delete(channel.ch);
    }
    channel.ch = undefined;
    channel.ready = false;
    this.#connected(channel, false);
  }
  #drop(channel: Channel): void {
    if (!this.#channels.delete(channel)) return;
    this.#unbind(channel);
    this.#idleIfEmpty();
  }
  #idleIfEmpty(): void {
    if ([...this.#channels].some((c) => !c.blocked)) return;
    this.#liveness?.();
    this.#liveness = undefined;
    this.#retry?.();
    this.#retry = undefined;
    if (this.#idle === undefined) {
      this.#idle = this.#clock.schedule(() => {
        this.#idle = undefined;
        this.#retire();
      }, 60_000);
    }
  }
  #retire(): void {
    this.#liveness?.();
    this.#liveness = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.onopen =
        socket.onmessage =
        socket.onclose =
        socket.onerror =
          null;
      socket.close();
    }
    this.#wire.clear();
    for (const channel of this.#channels) {
      channel.ch = undefined;
      channel.ready = false;
      this.#connected(channel, false);
    }
  }
  #lost(): void {
    this.#retire();
    if (this.#stopped || ![...this.#channels].some((c) => !c.blocked)) return;
    this.#retry = this.#clock.schedule(() => {
      this.#retry = undefined;
      this.#connect();
    }, Math.min(1000 * 2 ** Math.min(this.#attempt++, 4), 10_000));
  }
  #watch(): void {
    this.#liveness?.();
    this.#liveness = undefined;
    if (
      this.#socket?.readyState !== WebSocket.OPEN ||
      ![...this.#channels].some((c) => !c.blocked)
    ) return;
    this.#liveness = this.#clock.schedule(() => {
      this.#liveness = undefined;
      this.#lost();
    }, Math.max(0, 45_000 - (this.#clock.now() - this.#lastFrame)));
  }
  #connect(): void {
    if (this.#stopped || this.#socket || this.#retry !== undefined) return;
    const url = new URL("terminal", this.conn.base);
    url.protocol =
      globalThis.location?.protocol === "https:" || url.protocol === "https:"
        ? "wss:"
        : "ws:";
    let socket: WebSocket;
    try {
      socket = this.#socket = this.conn.options.socket?.(url) ??
        new WebSocket(url);
    } catch {
      this.#lost();
      return;
    }
    const current = () => this.#socket === socket && !this.#stopped;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (!current()) return;
      this.#lastFrame = this.#clock.now();
      this.#next = 1;
      for (const channel of this.#channels) {
        if (!channel.blocked) this.#bind(channel);
      }
      this.#emit({ kind: "refresh" });
    };
    socket.onmessage = ({ data }) => {
      if (!current()) return;
      this.#lastFrame = this.#clock.now();
      this.#watch();
      this.#message(data);
    };
    socket.onclose = socket.onerror = () => {
      if (current()) this.#lost();
    };
  }
  #message(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 4) return;
      const channel = this.#wire.get(new DataView(data).getUint32(0, false));
      if (channel?.ready) channel.sink.write(new Uint8Array(data, 4));
      return;
    }
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    if (message.t === "ping") {
      this.#send({ t: "pong" });
      return;
    }
    if (message.t === "pong") return;
    if (message.t === "gone") {
      for (const channel of [...this.#channels]) this.#drop(channel);
      this.#emit({ kind: "refresh" });
      return;
    }
    const channel = this.#wire.get(message.ch);
    if (!channel) return;
    switch (message.t) {
      case "snapshot": {
        // P2 sends checkpoint_base64 as the JSON checkpoint string.
        const raw = atob(message.checkpoint);
        const checkpoint = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        channel.sink.reset(message.cols, message.rows, checkpoint);
        channel.ready = true;
        if (channel.size) {
          this.#send({ t: "resize", ch: channel.ch, ...channel.size });
        }
        this.#attempt = 0;
        this.#connected(channel, true);
        channel.sink.meta({
          title: message.title,
          foreground: message.foreground,
          status: message.status,
        });
        break;
      }
      case "resized":
        if (channel.ready) channel.sink.resize(message.cols, message.rows);
        break;
      case "meta": {
        const { t: _t, ch: _ch, ...change } = message;
        channel.sink.meta(change);
        break;
      }
      case "exited":
        channel.sink.meta({ exited: message.exitCode, status: "exited" });
        this.#drop(channel);
        this.#emit({ kind: "refresh", session: channel.session });
        break;
      case "error":
        this.#drop(channel);
        this.#emit({ kind: "refresh", session: channel.session });
        break;
      case "detached": {
        this.#unbind(channel);
        if (message.reason === "terminated") {
          this.#drop(channel);
          this.#emit({ kind: "refresh", session: channel.session });
        } else {
          const now = this.#clock.now();
          if (channel.lastLag !== undefined && now - channel.lastLag < 10_000) {
            channel.blocked = true;
            this.#idleIfEmpty();
          } else {
            channel.lastLag = now;
            this.#bind(channel);
          }
        }
        break;
      }
    }
  }
  stop(): void {
    this.#stopped = true;
    this.#retry?.();
    this.#idle?.();
    this.#retire();
    this.#channels.clear();
    this.#listeners.clear();
  }
}

export interface SessionTerminalsState {
  list: TerminalInfo[];
  selected?: string;
  retained: string[];
  disconnected: string[];
  loading: boolean;
  error: FailureValue;
}

/** Session-owned list and four renderer leases; disposal leaves shells running. */
export class SessionTerminals {
  #current: SessionTerminalsState = {
    list: [],
    retained: [],
    disconnected: [],
    loading: false,
    error: "",
  };
  #store;
  #alive = true;
  #read?: AbortController;
  #unlisten: () => void;
  #retained = new Map<
    string,
    { sink: TerminalSink; attachment: TerminalAttachment }
  >();
  constructor(
    private socket: TerminalSocket,
    private conn: Pick<SidecarConnection, "rpc">,
    readonly sessionID: string,
    factory: StateFactory = createState,
  ) {
    this.#store = factory({ revision: 0 });
    this.#unlisten = socket.subscribe((event) => {
      if (event.session !== undefined && event.session !== sessionID) return;
      if (event.kind === "refresh") void this.refresh();
      else {
        this.#update((state) => {
          state.disconnected = state.disconnected.filter((id) =>
            id !== event.terminal
          );
          if (!event.connected) state.disconnected.push(event.terminal);
        });
      }
    });
  }
  get state(): SessionTerminalsState {
    void this.#store.state.revision;
    return this.#current;
  }
  subscribe(listener: (state: SessionTerminalsState) => void): () => void {
    return this.#store.subscribe(() => listener(this.#current));
  }
  #update(change: (state: SessionTerminalsState) => void): void {
    this.#current = { ...this.#current };
    change(this.#current);
    this.#store.update((state) => {
      state.revision++;
    });
  }
  async refresh(): Promise<void> {
    if (!this.#alive) return;
    this.#read?.abort();
    const read = this.#read = new AbortController();
    this.#update((state) => {
      state.loading = true;
      state.error = "";
    });
    try {
      if (read.signal.aborted) return;
      const list = await this.conn.rpc.call("terminal.list", {
        sessionID: this.sessionID,
      }, read.signal);
      if (!this.#alive || this.#read !== read) return;
      const ids = new Set(list.map((item) => item.id));
      for (const id of this.#retained.keys()) {
        if (!ids.has(id)) this.#release(id);
      }
      this.#update((state) => {
        state.list = list;
        state.disconnected = state.disconnected.filter((id) => ids.has(id));
        if (!state.selected || !ids.has(state.selected)) {
          state.selected = list[0]?.id;
        }
      });
    } catch (cause) {
      if (this.#alive && this.#read === read) {
        this.#update((state) => {
          state.error = failureValue(cause);
        });
      }
    } finally {
      if (this.#alive && this.#read === read) {
        this.#read = undefined;
        this.#update((state) => {
          state.loading = false;
        });
      }
    }
  }
  async create(cols: number, rows: number): Promise<TerminalInfo> {
    if (!this.#alive) throw new Error("Session terminals are disposed");
    const info = await this.conn.rpc.call("terminal.create", {
      sessionID: this.sessionID,
      cols,
      rows,
    });
    await this.refresh();
    if (this.#alive) {
      this.#update((state) => {
        state.selected = info.id;
      });
    }
    return info;
  }
  async close(id: string): Promise<void> {
    if (!this.#alive) throw new Error("Session terminals are disposed");
    await this.conn.rpc.call("terminal.close", {
      sessionID: this.sessionID,
      terminalID: id,
    });
    this.#release(id);
    await this.refresh();
  }
  #release(id: string): void {
    const lease = this.#retained.get(id);
    this.#retained.delete(id);
    lease?.attachment.close();
    this.#update((state) => {
      state.retained = [...this.#retained.keys()];
      state.disconnected = state.disconnected.filter((key) => key !== id);
    });
  }
  show(id: string, sink: TerminalSink): TerminalAttachment {
    if (!this.#alive) throw new Error("Session terminals are disposed");
    let lease = this.#retained.get(id);
    if (lease && (lease.sink !== sink || !lease.attachment.retained)) {
      this.#release(id);
      lease = undefined;
    }
    if (lease) {
      this.#retained.delete(id);
      lease.attachment.reconnect();
    } else {
      lease = {
        sink,
        attachment: this.socket.attach(this.sessionID, id, {
          reset: (cols, rows, checkpoint) => sink.reset(cols, rows, checkpoint),
          resize: (cols, rows) => sink.resize(cols, rows),
          write: (bytes) => sink.write(bytes),
          meta: (change) => {
            this.#update((state) => {
              state.list = state.list.map((info) =>
                info.id !== id ? info : {
                  ...info,
                  ...(change.title !== undefined
                    ? { title: change.title }
                    : {}),
                  ...(change.foreground !== undefined
                    ? { foreground: change.foreground }
                    : {}),
                  ...(change.status !== undefined
                    ? { status: change.status }
                    : {}),
                  ...(change.exited !== undefined
                    ? { exitCode: change.exited }
                    : {}),
                }
              );
            });
            sink.meta(change);
          },
        }),
      };
    }
    this.#retained.set(id, lease);
    while (this.#retained.size > 4) {
      this.#release(this.#retained.keys().next().value!);
    }
    this.#update((state) => {
      state.selected = id;
      state.retained = [...this.#retained.keys()];
    });
    return lease.attachment;
  }
  dispose(): void {
    this.#alive = false;
    this.#read?.abort();
    this.#unlisten();
    for (const id of this.#retained.keys()) this.#release(id);
  }
}
