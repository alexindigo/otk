// SPDX-License-Identifier: LGPL-3.0-only
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isSessionID } from "@otk/protocol";
import type { TerminalHost } from "./host.ts";
import type { DaemonConnection, PtyDaemon } from "./daemon.ts";
import type { Response } from "./frames.ts";
import { terminalOwner } from "./ownership.ts";

export interface TerminalSockets {
  accept(socket: WebSocket): void;
}
type RelayDaemon = Pick<
  PtyDaemon,
  "alive" | "request" | "subscribe" | "release"
>;
export interface TerminalRelayHost {
  daemon(): Promise<RelayDaemon>;
  onGone: TerminalHost["onGone"];
}
const CHUNK = 16 * 1024;
const CHANNEL_BUDGET = 256 * 1024;
const SOCKET_HIGH = 1024 * 1024;
const SOCKET_LOW = 256 * 1024;
const encoder = new TextEncoder();
type Control = Record<string, unknown>;
type Item = { data: string | Uint8Array; size: number; final?: boolean };
interface Channel {
  ch: number;
  id: number;
  session: string;
  attachment: string;
  cols: number;
  rows: number;
  controller: boolean;
  active: boolean;
  abort: AbortController;
  queue: Item[];
  queued: number;
  resume?: () => void;
  daemon?: RelayDaemon;
  connection?: DaemonConnection;
  ready: Promise<void>;
}
function positive(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 &&
    value <= max;
}

/** Application-owned terminal transport; the HTTP service sees only accept(). */
export class TerminalMux implements TerminalSockets {
  #sockets = new Set<Relay>();
  #unlisten: () => void;
  #stopped = false;
  constructor(
    private host: TerminalRelayHost,
    private directory: (
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {
    this.#unlisten = host.onGone(() => {
      for (const relay of this.#sockets) relay.gone();
    });
  }
  accept(socket: WebSocket): void {
    if (this.#stopped) {
      socket.close(1001, "Server stopping");
      return;
    }
    const relay = new Relay(
      socket,
      this.host,
      this.directory,
      () => this.#sockets.delete(relay),
    );
    this.#sockets.add(relay);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unlisten();
    await Promise.all([...this.#sockets].map((relay) => relay.stop()));
  }
}

class Relay {
  #channels = new Map<number, Channel>();
  #used = new Set<number>();
  #jobs = new Set<Promise<unknown>>();
  #open = true;
  #wake?: () => void;
  #pump: Promise<void>;
  #lastMessage = Date.now();
  #ping: ReturnType<typeof setInterval>;
  #cursor = 0;
  #settled?: Promise<void>;
  constructor(
    private socket: WebSocket,
    private host: TerminalRelayHost,
    private directory: (
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<string>,
    private closed: () => void,
  ) {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (!this.#open) return;
      this.#lastMessage = Date.now();
      try {
        this.#message(event.data);
      } catch {
        this.#close(1008, "Invalid terminal message");
      }
    };
    socket.onclose = () => this.#dispose();
    socket.onerror = () => this.#close(1011, "Terminal transport failed");
    this.#ping = setInterval(() => {
      if (Date.now() - this.#lastMessage > 60_000) {
        this.#close(1001, "Terminal ping timeout");
      } else this.#send({ t: "ping" });
    }, 20_000);
    this.#pump = this.#output().catch(() =>
      this.#close(1011, "Terminal transport failed")
    );
  }
  #track(work: Promise<unknown>): void {
    this.#jobs.add(work);
    void work.finally(() => this.#jobs.delete(work)).catch(() => {});
  }
  #send(message: Control): void {
    if (this.#open && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
  #signal(): void {
    this.#wake?.();
    this.#wake = undefined;
  }
  #remove(channel: Channel): void {
    channel.active = false;
    channel.abort.abort();
    if (channel.connection) channel.daemon?.release(channel.connection);
    channel.connection = undefined;
    channel.resume?.();
    channel.resume = undefined;
  }
  #dispose(): void {
    if (!this.#open) return;
    this.#open = false;
    clearInterval(this.#ping);
    for (const channel of this.#channels.values()) this.#remove(channel);
    this.#channels.clear();
    this.#signal();
    // A closed socket may still have an attach or input in flight. Retain its
    // relay owner until those lifetimes settle, so application stop joins them.
    this.#settled = Promise.resolve().then(async () => {
      await this.#pump;
      while (this.#jobs.size) await Promise.allSettled([...this.#jobs]);
      this.closed();
    });
  }
  #close(code: number, reason: string): void {
    if (!this.#open) return;
    this.socket.close(code, reason);
    this.#dispose();
  }
  gone(): void {
    this.#send({ t: "gone" });
    this.#close(1011, "Terminal daemon gone");
  }
  async stop(): Promise<void> {
    this.#close(1001, "Server stopping");
    await this.#settled;
  }
  #message(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 4 || data.byteLength > 64 * 1024) {
        throw new Error("Input size");
      }
      const channel = this.#channels.get(
        new DataView(data).getUint32(0, false),
      );
      if (!channel?.active) return;
      const bytes = new Uint8Array(data, 4);
      this.#interact(channel, async () => {
        await channel.daemon!.request({
          op: "input",
          id: channel.id,
          attachment_id: channel.attachment,
          cols: channel.cols,
          rows: channel.rows,
          data_base64: encodeBase64(bytes),
        });
        channel.controller = true;
      });
      return;
    }
    if (typeof data !== "string" || encoder.encode(data).length > 4096) {
      throw new Error("Control size");
    }
    const message = JSON.parse(data);
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Control object");
    }
    if (message.t === "ping") {
      this.#send({ t: "pong" });
      return;
    }
    if (message.t === "pong") return;
    const ch = message.ch;
    if (!positive(ch, 0xffffffff)) throw new Error("Channel number");
    if (message.t === "attach") {
      if (this.#used.has(ch)) throw new Error("Channel reused");
      if (
        typeof message.session !== "string" || message.session.length > 512 ||
        !isSessionID(message.session) || typeof message.terminal !== "string" ||
        !/^[1-9][0-9]*$/.test(message.terminal) ||
        !Number.isSafeInteger(Number(message.terminal))
      ) throw new Error("Attach identity");
      this.#used.add(ch);
      if (this.#channels.size >= 16) {
        this.#send({ t: "error", ch, code: "too-many" });
        return;
      }
      const channel: Channel = {
        ch,
        id: Number(message.terminal),
        session: message.session,
        attachment: crypto.randomUUID(),
        cols: 80,
        rows: 24,
        controller: false,
        active: true,
        abort: new AbortController(),
        queue: [],
        queued: 0,
        ready: Promise.resolve(),
      };
      this.#channels.set(ch, channel);
      channel.ready = this.#attach(channel).catch(() => {
        if (this.#open && channel.active) {
          this.#send({ t: "error", ch, code: "not-found" });
          this.#remove(channel);
          this.#channels.delete(ch);
        }
      });
      this.#track(channel.ready);
      return;
    }
    if (message.t !== "detach" && message.t !== "resize") {
      throw new Error("Unknown terminal control");
    }
    if (
      message.t === "resize" &&
      (!positive(message.cols, 65535) || !positive(message.rows, 65535))
    ) throw new Error("Terminal size");
    const channel = this.#channels.get(ch);
    if (!channel?.active) return;
    if (message.t === "detach") {
      this.#remove(channel);
      this.#channels.delete(ch);
      this.#signal();
    } else {
      this.#interact(channel, async () => {
        channel.cols = message.cols;
        channel.rows = message.rows;
        await channel.daemon!.request({
          op: channel.controller ? "resize" : "control",
          id: channel.id,
          attachment_id: channel.attachment,
          cols: channel.cols,
          rows: channel.rows,
        });
        channel.controller = true;
      });
    }
  }
  #interact(channel: Channel, run: () => Promise<void>): void {
    // The daemon owns per-terminal ordering/coalescing across browser sockets.
    // Do not put input behind the output reader or output scheduler.
    this.#track(
      channel.ready.then(async () => {
        if (channel.active && this.#open) await run();
      }).catch(async () => {
        if (channel.active && this.#open) {
          await this.#subscriptionEnded(channel);
        }
      }),
    );
  }
  #control(channel: Channel, message: Control, final = false): void {
    const data = JSON.stringify({ ...message, ch: channel.ch });
    const size = encoder.encode(data).length;
    channel.queue.push({ data, size, final });
    channel.queued += size;
    this.#signal();
  }
  #end(channel: Channel, message: Control): void {
    this.#control(channel, message, true);
    this.#remove(channel);
  }
  async #bytes(channel: Channel, bytes: Uint8Array): Promise<void> {
    for (
      let offset = 0;
      offset < bytes.length && channel.active && this.#open;
      offset += CHUNK
    ) {
      while (channel.queued >= CHANNEL_BUDGET && channel.active && this.#open) {
        await new Promise<void>((resolve) => channel.resume = resolve);
      }
      if (!channel.active || !this.#open) return;
      const data = bytes.slice(offset, offset + CHUNK);
      channel.queue.push({ data, size: data.length });
      channel.queued += data.length;
      this.#signal();
    }
  }
  async #attach(channel: Channel): Promise<void> {
    const directory = await this.directory(
      channel.session,
      channel.abort.signal,
    );
    const daemon = await this.host.daemon();
    if (!channel.active || !this.#open) return;
    channel.daemon = daemon;
    const metadata = await daemon.request({ op: "get", id: channel.id });
    if (
      metadata.type !== "process" ||
      terminalOwner(metadata.process.group_id)?.dir !== directory ||
      !metadata.process.pty
    ) throw new Error("Terminal not found");
    if (!channel.active || !this.#open) return;
    let connection = await this.#subscribe(channel, 0n);
    if (!connection) return;
    let first = connection.first;
    let process = first.process;
    let checkpoint = "";
    let restore = "replay";
    // Always request zero: truncated=false at a nonzero head does not establish
    // completeness. An active-screen checkpoint cannot recover the inactive one.
    if (first.truncated) {
      daemon.release(connection.stream);
      channel.connection = undefined;
      const snapshot = await daemon.request({ op: "snapshot", id: channel.id });
      if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
      if (!channel.active || !this.#open) return;
      checkpoint = snapshot.checkpoint_base64;
      process = snapshot.process;
      restore = "checkpoint";
      // The old connection's unsubscribe must not retire the replacement lease.
      channel.attachment = crypto.randomUUID();
      connection = await this.#subscribe(channel, snapshot.process.output_tail);
      if (!connection) return;
      first = connection.first;
    }
    const pty = process.pty!;
    channel.cols = pty.cols;
    channel.rows = pty.rows;
    this.#control(channel, {
      t: "snapshot",
      cols: pty.cols,
      rows: pty.rows,
      checkpoint,
      restore,
      title: pty.title,
      foreground: pty.foreground_process,
      status: process.lifecycle.status === "running" ? "running" : "exited",
    });
    // Replay drains independently, never holding keyboard ingress at its budget.
    this.#track(this.#read(channel, connection.stream, first));
  }
  async #subscribe(channel: Channel, offset: bigint): Promise<
    {
      stream: DaemonConnection;
      first: Extract<Response, { type: "attached" }>;
    } | undefined
  > {
    const daemon = channel.daemon!;
    const connection = await daemon.subscribe({
      op: "subscribe",
      id: channel.id,
      offset,
      attachment_id: channel.attachment,
      role: "observer",
      takeover: false,
    });
    if (!channel.active || !this.#open) {
      daemon.release(connection);
      return;
    }
    channel.connection = connection;
    // Sending subscribe does not establish the attachment. Keyboard and resize
    // requests must wait for the daemon's acknowledgement, not race its actor.
    const timer = setTimeout(() => daemon.release(connection), 5000);
    let first;
    try {
      first = await connection.next();
    } finally {
      clearTimeout(timer);
    }
    if (!channel.active || !this.#open) return;
    if (first?.kind !== "json" || first.value.type !== "attached") {
      throw new Error("Terminal attachment refused");
    }
    return { stream: connection, first: first.value };
  }
  async #read(
    channel: Channel,
    connection: DaemonConnection,
    first: Response,
  ): Promise<void> {
    try {
      if (!await this.#event(channel, first)) return;
      while (channel.active && this.#open) {
        while (
          channel.queued >= CHANNEL_BUDGET && channel.active && this.#open
        ) await new Promise<void>((resolve) => channel.resume = resolve);
        if (!channel.active || !this.#open) return;
        const frame = await connection.next();
        if (frame === null) {
          await this.#subscriptionEnded(channel);
          return;
        }
        if (frame.kind === "output") await this.#bytes(channel, frame.bytes);
        else if (!await this.#event(channel, frame.value)) return;
      }
    } catch {
      if (channel.active && this.#open) {
        await this.#subscriptionEnded(channel);
      }
    } finally {
      if (channel.connection === connection) {
        channel.daemon?.release(connection);
        channel.connection = undefined;
      }
    }
  }
  async #subscriptionEnded(channel: Channel): Promise<void> {
    const daemon = channel.daemon!;
    if (!daemon.alive) {
      this.gone();
      return;
    }
    let reason = "lagging";
    try {
      const reply = await daemon.request({ op: "get", id: channel.id });
      if (reply.type !== "process") {
        throw new Error("Expected terminal metadata");
      }
    } catch (cause) {
      if (!daemon.alive) {
        this.gone();
        return;
      }
      // The pinned daemon's service::handle error is the authoritative absence
      // response. A transport failure is not proof that a terminal was removed.
      if (
        cause instanceof Error &&
        cause.message === `process ${channel.id} not found`
      ) reason = "terminated";
    }
    if (channel.active && this.#open) {
      this.#end(channel, { t: "detached", reason });
    }
  }
  async #event(channel: Channel, event: Response): Promise<boolean> {
    switch (event.type) {
      case "attached":
        if (event.truncated) {
          this.#end(channel, { t: "detached", reason: "lagging" });
          return false;
        }
        channel.controller = event.role === "controller";
        this.#control(channel, { t: "meta", role: event.role });
        await this.#bytes(channel, decodeBase64(event.replay_base64));
        break;
      case "resized":
        channel.cols = event.cols;
        channel.rows = event.rows;
        this.#control(channel, {
          t: "resized",
          cols: event.cols,
          rows: event.rows,
          checkpoint: event.checkpoint_base64,
        });
        break;
      case "controller_changed":
        channel.controller = event.attachment_id === channel.attachment;
        this.#control(channel, {
          t: "meta",
          role: channel.controller ? "controller" : "observer",
        });
        break;
      case "title_changed":
        this.#control(channel, { t: "meta", title: event.title });
        break;
      case "foreground_process_changed":
        this.#control(channel, { t: "meta", foreground: event.process });
        break;
      case "exited":
        this.#end(channel, { t: "exited", exitCode: event.exit_code });
        return false;
      case "error":
        await this.#subscriptionEnded(channel);
        return false;
      default:
        throw new Error("Unexpected daemon subscription event");
    }
    return true;
  }
  async #output(): Promise<void> {
    let throttled = false;
    while (this.#open) {
      if (this.socket.bufferedAmount > SOCKET_HIGH) throttled = true;
      if (throttled && this.socket.bufferedAmount >= SOCKET_LOW) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throttled = false;
      const channels = [...this.#channels.values()];
      let sent = false;
      // Resume the round where a high-water break left off, not always at ch 1.
      for (let turn = 0; turn < channels.length; turn++) {
        const channel = channels[this.#cursor % channels.length];
        this.#cursor++;
        const item = channel.queue.shift();
        if (!item) continue;
        sent = true;
        channel.queued -= item.size;
        if (typeof item.data === "string") this.socket.send(item.data);
        else {
          const frame = new Uint8Array(4 + item.data.length);
          new DataView(frame.buffer).setUint32(0, channel.ch, false);
          frame.set(item.data, 4);
          this.socket.send(frame);
        }
        if (channel.queued < CHANNEL_BUDGET / 2) {
          channel.resume?.();
          channel.resume = undefined;
        }
        if (item.final) this.#channels.delete(channel.ch);
        if (this.socket.bufferedAmount > SOCKET_HIGH) break;
      }
      if (sent) {
        // A macrotask gives subscription readers and keyboard ingress a turn.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } else await new Promise<void>((resolve) => this.#wake = resolve);
    }
  }
}
