// SPDX-License-Identifier: LGPL-3.0-only
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";
import type { ServerFrame, ViewLease } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import { PROTOCOL_VERSION } from "@otk/protocol";
import { type ClientIndex, createIndex, RequestFailure } from "@otk/client";
import type { RequestEvent } from "@otk/protocol";
import { waitFor } from "./opencode.ts";
import { resources } from "./resources.ts";
export function ownSocket(socket: WebSocket): () => Promise<void> {
  return resources().defer("WebSocket client", async () => {
    if (socket.readyState === WebSocket.CLOSED) {
      socket.removeAllListeners();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => socket.terminate(), 1000);
      socket.once("close", () => {
        clearTimeout(timer);
        socket.removeAllListeners();
        resolve();
      });
      socket.close();
    });
  });
}
export class WsClient {
  autoAcceptPages = true;
  frames: ServerFrame[] = [];
  ws: WebSocket;
  #clientID = crypto.randomUUID();
  #index: ClientIndex = createIndex();
  #indexed = 0;
  #close: () => Promise<void>;
  #welcome?: Extract<ServerFrame, { t: "welcome" }>;
  #view: ViewLease = { epoch: 0, crumbs: [], rows: [] };
  lease(value: Omit<ViewLease, "epoch">): void {
    this.#view = { ...value, epoch: this.#view.epoch + 1 };
    if (this.#welcome) this.send({ t: "view", ...this.#view });
  }
  constructor(readonly base: string, cookie?: string, origin = base) {
    resources();
    this.ws = new WebSocket(base.replace(/^http/, "ws") + "/api/ws", {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
    this.ws.on("message", (data) => {
      const frame: ServerFrame = JSON.parse(data.toString());
      if (frame.epoch !== undefined && frame.epoch < this.#view.epoch) return;
      if (frame.t === "welcome") this.#welcome = frame;
      this.frames.push(frame);
      this.#reduceIndex();
      if (frame.t === "ping") this.send({ t: "pong" });
    });
    this.ws.on("error", () => {});
    this.#close = ownSocket(this.ws);
  }
  async connect(directory?: string, selected?: string): Promise<void> {
    if (directory) this.lease({ directory, selected, crumbs: [], rows: [] });
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        if (this.ws.readyState !== WebSocket.CONNECTING) {
          reject(new Error("Socket closed before hello"));
          return;
        }
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.ws.off("open", opened);
          this.ws.off("error", failed);
          this.ws.off("close", closed);
          error ? reject(error) : resolve();
        };
        const opened = () => finish(),
          failed = (error: Error) => finish(error),
          closed = () => finish(new Error("Socket closed before hello"));
        const timer = setTimeout(
          () => finish(new Error("Socket open timed out")),
          30_000,
        );
        this.ws.once("open", opened);
        this.ws.once("error", failed);
        this.ws.once("close", closed);
      });
    }
    this.send({ t: "hello", protocol: PROTOCOL_VERSION, view: this.#view });
    await this.wait((frame) => frame.t === "welcome");
  }
  send(value: unknown): void {
    this.ws.send(JSON.stringify(value));
  }
  acceptPage(sessionID: string): void {
    if (this.#view.selected === sessionID) {
      this.send({ t: "view.settled", epoch: this.#view.epoch, sessionID });
    }
  }
  /** Lazy so raw-wire/timing consumers do not acquire another projection. */
  entry(sessionID: string): IndexEntry | undefined {
    if (
      !this.#view.rows.includes(sessionID) &&
      !this.#view.crumbs.includes(sessionID) &&
      this.#view.selected !== sessionID
    ) {
      this.lease({
        ...this.#view,
        selected: this.#view.selected,
        crumbs: [...this.#view.crumbs, sessionID],
      });
    }
    this.#reduceIndex();
    return this.#index.get("test", sessionID);
  }
  #reduceIndex(): void {
    const frames = this.frames.slice(this.#indexed);
    this.#indexed = this.frames.length;
    for (const frame of frames) {
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (!this.#index.receive("test", frame)) this.send({ t: "resnapshot" });
        else if (frame.epoch !== undefined) {
          this.send({ t: "index.applied", epoch: frame.epoch, rev: frame.rev });
        }
      }
    }
  }
  wait(
    predicate: (frame: ServerFrame) => boolean,
    timeout = 30_000,
  ): Promise<ServerFrame> {
    return waitFor(
      () => this.frames.find(predicate),
      (frame) => frame !== undefined,
      timeout,
    ) as Promise<ServerFrame>;
  }
  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const welcome = this.#welcome;
    if (!welcome || welcome.t !== "welcome") {
      throw new Error("Request needs a welcome");
    }
    const ref = {
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      clientID: this.#clientID,
      window: welcome.requests.window.id,
    };
    this.send({ t: "request", ref, method, params });
    const frame = await this.wait((frame) =>
      (frame.t === "request.result" || frame.t === "request.rejected") &&
      frame.ref.key === ref.key
    ) as Extract<RequestEvent, { t: "request.result" | "request.rejected" }>;
    if (frame.t === "request.rejected") throw new RequestFailure(frame.error);
    this.send({ t: "request.received", refs: [{ ref, seq: frame.seq }] });
    if (!frame.outcome.ok) {
      throw new RequestFailure(frame.outcome.error);
    }
    if (
      this.autoAcceptPages && method === "session.messages" && params &&
      typeof params === "object" &&
      "sessionID" in params && typeof params.sessionID === "string" &&
      !("before" in params)
    ) {
      this.acceptPage(params.sessionID);
    }
    return frame.outcome.result as T;
  }
  async close(): Promise<void> {
    await this.#close();
  }
}
