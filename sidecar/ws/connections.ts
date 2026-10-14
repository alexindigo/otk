// SPDX-License-Identifier: LGPL-3.0-only
import { type ContentOp, isAttentionOp, type Preferences } from "@otk/protocol";
import type { ClientFrame, HarnessState, ServerFrame } from "@otk/protocol";
import { checkClientFrameSize } from "@otk/protocol";
import { PROTOCOL_VERSION, SIDECAR_VERSION } from "@otk/protocol";
import { type Harness, HarnessError } from "@otk/harness";
import type { IndexStore } from "../index/store.ts";
import { dispatch, object, text } from "./rpc.ts";
import type { Frecency, Prefs } from "@otk/store";
interface Connection {
  ws: WebSocket;
  welcomed: boolean;
  sessions: Set<string>;
}
export class Connections {
  #connections = new Set<Connection>();
  #counts = new Map<string, number>();
  harnessState: HarnessState = "connecting";
  #stopPrefs: () => void;
  constructor(
    readonly adapter: Harness,
    readonly index: IndexStore,
    readonly url: string,
    readonly prefs: Prefs<Preferences>,
    readonly frecency: Frecency,
  ) {
    index.listen((frame) => this.broadcast(frame));
    this.#stopPrefs = prefs.listen((prefs) =>
      this.broadcast({ t: "prefs", prefs })
    );
  }
  #send(connection: Connection, frame: ServerFrame): void {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(frame));
    }
  }
  broadcast(frame: ServerFrame): void {
    for (const connection of this.#connections) {
      if (connection.welcomed) this.#send(connection, frame);
    }
  }
  connection(state: HarnessState): void {
    this.harnessState = state;
    this.broadcast({ t: "harness", state });
  }
  content(sessionID: string, event: ContentOp): void {
    const recipients = isAttentionOp(event)
      ? [sessionID, ...this.index.ancestors(sessionID)]
      : [sessionID];
    for (const connection of this.#connections) {
      if (
        connection.welcomed &&
        recipients.some((id) => connection.sessions.has(id))
      ) {
        this.#send(connection, { t: "content", sessionID, event });
      }
    }
  }
  #subscribe(
    connection: Connection,
    sessionID: string,
    subscribe: boolean,
  ): void {
    if (subscribe === connection.sessions.has(sessionID)) return;
    if (subscribe) connection.sessions.add(sessionID);
    else connection.sessions.delete(sessionID);
    const count = (this.#counts.get(sessionID) ?? 0) + (subscribe ? 1 : -1);
    if (count) this.#counts.set(sessionID, count);
    else this.#counts.delete(sessionID);
    this.adapter.core.subscriptions(sessionID, count);
  }
  accept(ws: WebSocket): void {
    const connection: Connection = { ws, welcomed: false, sessions: new Set() };
    this.#connections.add(connection);
    const helloDeadline = setTimeout(() => {
      if (!connection.welcomed) ws.close(1008, "hello required");
    }, 10_000);
    const ping = setInterval(
      () => this.#send(connection, { t: "ping" }),
      20_000,
    );
    const silent = () => ws.close(1001, "heartbeat timeout");
    let silenceDeadline = setTimeout(silent, 60_000);
    ws.onclose = () => {
      clearTimeout(helloDeadline);
      clearTimeout(silenceDeadline);
      clearInterval(ping);
      for (const sessionID of connection.sessions) {
        this.#subscribe(connection, sessionID, false);
      }
      this.#connections.delete(connection);
    };
    ws.onmessage = async (event) => {
      let rpcID: string | undefined;
      try {
        if (typeof event.data !== "string") {
          throw new HarnessError("frame", "Invalid frame");
        }
        const raw = object(JSON.parse(event.data)),
          frame = raw as unknown as ClientFrame;
        if (connection.welcomed && frame.t === "rpc") rpcID = text(raw, "id")!;
        try {
          checkClientFrameSize(event.data);
        } catch (error) {
          throw new HarnessError("frame", (error as Error).message);
        }
        if (!connection.welcomed) {
          if (frame.t !== "hello" || frame.protocol !== PROTOCOL_VERSION) {
            this.#send(connection, { t: "error", code: "protocol" });
            ws.close(1002, "protocol mismatch");
            return;
          }
          connection.welcomed = true;
          clearTimeout(helloDeadline);
          clearTimeout(silenceDeadline);
          silenceDeadline = setTimeout(silent, 60_000);
          this.#send(connection, {
            t: "welcome",
            protocol: PROTOCOL_VERSION,
            sidecar: {
              version: SIDECAR_VERSION,
              harness: {
                kind: this.adapter.core.kind,
                version: this.adapter.core.version,
                url: this.url,
              },
            },
          });
          this.#send(connection, { t: "harness", state: this.harnessState });
          this.#send(connection, this.index.snapshot());
          this.#send(connection, { t: "prefs", prefs: this.prefs.get() });
          return;
        }
        if (frame.t === "pong") {
          clearTimeout(silenceDeadline);
          silenceDeadline = setTimeout(silent, 60_000);
          return;
        }
        if (frame.t === "subscribe" || frame.t === "unsubscribe") {
          this.#subscribe(
            connection,
            text(raw, "sessionID")!,
            frame.t === "subscribe",
          );
        } else if (frame.t === "resnapshot") {
          this.#send(connection, this.index.snapshot());
        } else if (frame.t === "rpc") {
          const id = text(raw, "id")!;
          try {
            const result = await dispatch(
              this.adapter,
              text(raw, "method")!,
              frame.params,
              this.prefs,
              this.frecency,
            );
            this.#send(connection, { t: "rpc.result", id, ok: true, result });
          } catch (error) {
            this.#send(connection, {
              t: "rpc.result",
              id,
              ok: false,
              error: {
                code: error instanceof HarnessError ? error.code : "harness",
                message: (error as Error).message,
              },
            });
          }
        } else throw new HarnessError("frame", "Unknown frame");
        clearTimeout(silenceDeadline);
        silenceDeadline = setTimeout(silent, 60_000);
      } catch (error) {
        const detail = {
          code: error instanceof HarnessError ? error.code : "frame",
          message: (error as Error).message,
        };
        this.#send(
          connection,
          rpcID
            ? { t: "rpc.result", id: rpcID, ok: false, error: detail }
            : { t: "error", ...detail },
        );
      }
    };
  }
  close(): void {
    this.#stopPrefs();
    for (const connection of this.#connections) {
      connection.ws.close(1001, "server stopping");
    }
  }
}
