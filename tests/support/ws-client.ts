// SPDX-License-Identifier: LGPL-3.0-only
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";
import type { ServerFrame } from "../../protocol/messages.ts";
import { PROTOCOL_VERSION } from "../../protocol/version.ts";
import { waitFor } from "./opencode.ts";
export class WsClient {
  frames: ServerFrame[] = [];
  ws: WebSocket;
  #next = 0;
  constructor(readonly base: string, cookie?: string, origin = base) {
    this.ws = new WebSocket(base.replace(/^http/, "ws") + "/api/ws", {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
    this.ws.on("message", (data) => {
      const frame: ServerFrame = JSON.parse(data.toString());
      this.frames.push(frame);
      if (frame.t === "ping") this.send({ t: "pong" });
    });
    this.ws.on("error", () => {});
  }
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.send({ t: "hello", protocol: PROTOCOL_VERSION });
    await this.wait((frame) => frame.t === "welcome");
  }
  send(value: unknown): void {
    this.ws.send(JSON.stringify(value));
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
    const id = String(++this.#next);
    this.send({ t: "rpc", id, method, params });
    const frame = await this.wait((frame) =>
      frame.t === "rpc.result" && frame.id === id
    ) as Extract<ServerFrame, { t: "rpc.result" }>;
    if (!frame.ok) {
      throw new Error(`${frame.error.code}: ${frame.error.message}`);
    }
    return frame.result as T;
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}
