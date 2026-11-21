// SPDX-License-Identifier: LGPL-3.0-only
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isSessionID } from "@otk/protocol";
import type { TerminalHost } from "./host.ts";
import {
  type DaemonConnection,
  DaemonOverloadedError,
  type PtyDaemon,
} from "./daemon.ts";
import type { Response } from "./frames.ts";
import {
  TERMINAL_INPUT_MAX,
  TERMINAL_SOCKET_HIGH,
  TerminalIngress,
} from "./ingress.ts";

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
const SOCKET_HIGH = TERMINAL_SOCKET_HIGH;
const SOCKET_LOW = 256 * 1024;
const encoder = new TextEncoder();
type Control = Record<string, unknown>;
type Item = { data: string | Uint8Array; size: number; final?: boolean };
type Interaction = { run: () => Promise<void>; release: () => void };
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
  attached: boolean;
  pending: Interaction[];
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
  constructor(private host: TerminalRelayHost) {
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
  #ingress = new TerminalIngress();
  #attachments = new TerminalIngress();
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
      if (this.socket.bufferedAmount > SOCKET_HIGH) {
        this.#close(1013, "Terminal receiver is not draining");
        return;
      }
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
    for (const job of channel.pending.splice(0)) job.release();
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
      if (data.byteLength < 4 || data.byteLength > TERMINAL_INPUT_MAX) {
        throw new Error("Input size");
      }
      const channel = this.#channels.get(
        new DataView(data).getUint32(0, false),
      );
      if (!channel?.active) return;
      const bytes = new Uint8Array(data, 4);
      this.#interact(channel, data.byteLength, async () => {
        await channel.daemon!.request({
          op: "input",
          id: channel.id,
          attachment_id: channel.attachment,
          cols: channel.cols,
          rows: channel.rows,
          data_base64: encodeBase64(bytes),
        }, channel.abort.signal);
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
      const release = this.#admit(4096, this.#attachments);
      if (!release) return;
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
        attached: false,
        pending: [],
        queue: [],
        queued: 0,
        ready: Promise.resolve(),
      };
      this.#channels.set(ch, channel);
      channel.ready = this.#attach(channel).then(() => {
        if (!channel.active || !this.#open) return;
        channel.attached = true;
        for (const job of channel.pending.splice(0)) {
          this.#dispatch(channel, job);
        }
      }).catch((cause) => {
        if (this.#open && channel.active) {
          if (cause instanceof DaemonOverloadedError) {
            this.#close(1013, "Terminal ingress overloaded");
            return;
          }
          this.#send({ t: "error", ch, code: "not-found" });
          this.#remove(channel);
          this.#channels.delete(ch);
        }
      }).finally(release);
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
      this.#interact(channel, 4096, async () => {
        channel.cols = message.cols;
        channel.rows = message.rows;
        await channel.daemon!.request({
          op: "control",
          id: channel.id,
          attachment_id: channel.attachment,
          cols: message.cols,
          rows: message.rows,
        }, channel.abort.signal);
        channel.controller = true;
        // Acceptance is not a canonical grid event. Control need not emit
        // Resized for an unchanged grid; only the subscription owns that stream.
        this.#control(channel, {
          t: "resize-ack",
          cols: message.cols,
          rows: message.rows,
        });
      });
    }
  }
  #admit(bytes: number, budget = this.#ingress): (() => void) | undefined {
    try {
      return budget.admit(bytes);
    } catch {
      this.#close(1013, "Terminal ingress overloaded");
    }
  }
  #interact(channel: Channel, bytes: number, run: () => Promise<void>): void {
    // The daemon owns per-terminal ordering/coalescing across browser sockets.
    // Do not put input behind the output reader or output scheduler.
    const release = this.#admit(bytes);
    if (!release) return;
    const job = { run, release };
    if (!channel.attached) channel.pending.push(job);
    else this.#dispatch(channel, job);
  }
  #dispatch(channel: Channel, job: Interaction): void {
    if (!channel.active || !this.#open) {
      job.release();
      return;
    }
    this.#track(
      job.run().catch((cause) => {
        if (channel.active && this.#open) {
          if (cause instanceof DaemonOverloadedError) {
            this.#close(1013, "Terminal ingress overloaded");
          } else if (!channel.daemon?.alive) this.gone();
          else this.#control(channel, { t: "interaction-error" });
        }
      }).finally(job.release),
    );
  }
  #control(channel: Channel, message: Control, final = false): void {
    if (!this.#open || (!channel.active && !final)) return;
    if (channel.queued >= CHANNEL_BUDGET && !final) {
      this.#close(1013, "Terminal receiver is not draining");
      return;
    }
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
    const daemon = await this.host.daemon();
    if (!channel.active || !this.#open) return;
    channel.daemon = daemon;
    const snapshot = await daemon.request(
      { op: "snapshot", id: channel.id },
      channel.abort.signal,
    );
    if (
      snapshot.type !== "snapshot" ||
      snapshot.process.group_id !== channel.session || !snapshot.process.pty
    ) throw new Error("Terminal not found");
    if (!channel.active || !this.#open) return;
    const pty = snapshot.process.pty;
    channel.cols = pty.cols;
    channel.rows = pty.rows;
    this.#control(channel, {
      t: "snapshot",
      cols: pty.cols,
      rows: pty.rows,
      checkpoint: snapshot.checkpoint_base64,
      title: pty.title,
      foreground: pty.foreground_process,
      status: snapshot.process.lifecycle.status === "running"
        ? "running"
        : "exited",
    });
    const connection = await daemon.subscribe({
      op: "subscribe",
      id: channel.id,
      offset: snapshot.process.output_tail,
      attachment_id: channel.attachment,
      role: "observer",
      takeover: false,
    }, channel.abort.signal);
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
    // Subscription reading is independent per channel. Only this reader pauses
    // at its queue budget, leaving every other terminal and input path runnable.
    // Replay drains in that reader, not in ready: input never waits for output.
    this.#track(this.#read(channel, connection, first.value));
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
