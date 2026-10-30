// SPDX-License-Identifier: LGPL-3.0-only
import {
  capabilityNames,
  checkClientFrameSize,
  isAttentionOp,
  PROTOCOL_VERSION,
  requestFingerprint,
  requestRef,
  SIDECAR_VERSION,
} from "@otk/protocol";
import type {
  ClientFrame,
  ClientRequestPolicy,
  ContentClock,
  ContentOp,
  HarnessState,
  MessagePolicy,
  Preferences,
  RequestControl,
  RequestEvent,
  RequestRef,
  ServerFrame,
} from "@otk/protocol";
import { type Harness, HarnessError } from "@otk/harness";
import type { Prefs } from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import { object, sessionID } from "./params.ts";
import type { RpcRegistry } from "./registry.ts";
import type { SectionObserver } from "../diagnostics.ts";
import type { RequestCoordinator } from "../requests/coordinator.ts";
import { ExecutionFailure, publicFailure } from "../requests/failures.ts";

interface Connection {
  ws: WebSocket;
  welcomed: boolean;
  sessions: Set<string>;
  close(): void;
}
export interface FrameSource {
  snapshot(): ServerFrame;
  listen(listener: (frame: ServerFrame) => void): () => void;
  close?(): void;
}
export interface ConnectionRequests {
  coordinator: RequestCoordinator;
  identity(): string;
  policy: ClientRequestPolicy;
  helloms: number;
}
/** Socket recipients own delivery and leases, never action execution. */
export class Connections {
  #connections = new Set<Connection>();
  #counts = new Map<string, number>();
  harnessState: HarnessState = "connecting";
  #stops: (() => void)[] = [];
  #closed = false;
  constructor(
    readonly backend: Harness,
    readonly index: IndexStore,
    readonly url: string,
    readonly prefs: Prefs<Preferences>,
    readonly rpc: RpcRegistry,
    readonly messages: MessagePolicy,
    readonly requests: ConnectionRequests,
    readonly sources: readonly FrameSource[] = [],
    readonly diagnostics?: SectionObserver,
  ) {
    try {
      this.#stops.push(index.listen((frame) => this.broadcast(frame)));
      this.#stops.push(
        prefs.listen((prefs) => this.broadcast({ t: "prefs", prefs })),
      );
      for (const source of sources) {
        this.#stops.push(source.listen((frame) => this.broadcast(frame)));
      }
    } catch (error) {
      const failures: unknown[] = [error];
      for (const stop of this.#stops.splice(0).reverse()) {
        try {
          stop();
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Connection subscriptions failed", {
          cause: error,
        });
      }
      throw error;
    }
  }
  #send(connection: Connection, frame: ServerFrame): void {
    if (
      this.#connections.has(connection) &&
      connection.ws.readyState === WebSocket.OPEN
    ) {
      const start = performance.now(), serialized = JSON.stringify(frame);
      this.diagnostics?.(`serialize:${frame.t}`, performance.now() - start);
      connection.ws.send(serialized);
    }
  }
  broadcast(frame: ServerFrame): void {
    for (const c of this.#connections) if (c.welcomed) this.#send(c, frame);
  }
  connection(state: HarnessState): void {
    this.harnessState = state;
    this.broadcast({ t: "harness", state });
  }
  content(sessionID: string, event: ContentOp, clock?: ContentClock): void {
    const recipients = isAttentionOp(event)
      ? [sessionID, ...this.index.ancestors(sessionID)]
      : [sessionID];
    for (const c of this.#connections) {
      if (c.welcomed && recipients.some((id) => c.sessions.has(id))) {
        this.#send(c, {
          t: "content",
          sessionID,
          event,
          ...(clock ? { clock } : {}),
        });
      }
    }
  }
  #subscribe(c: Connection, id: string, enabled: boolean): void {
    if (enabled === c.sessions.has(id)) return;
    if (enabled) c.sessions.add(id);
    else c.sessions.delete(id);
    const count = (this.#counts.get(id) ?? 0) + (enabled ? 1 : -1);
    if (count) this.#counts.set(id, count);
    else this.#counts.delete(id);
    this.backend.core.subscriptions(id, count);
  }
  accept(ws: WebSocket): void {
    if (this.#closed) {
      ws.close(1001, "server stopping");
      return;
    }
    const c: Connection = {
      ws,
      welcomed: false,
      sessions: new Set(),
      close: () => dispose(),
    };
    this.#connections.add(c);
    const controller = new AbortController(), releases = new Set<() => void>();
    const lease = {
      id: crypto.randomUUID(),
      signal: controller.signal,
      defer(release: () => void) {
        if (controller.signal.aborted) release();
        else releases.add(release);
      },
    };
    const recipient = {
      send: (event: RequestEvent) => this.#send(c, event),
      lease,
    };
    let principal = "", welcoming = false;
    const policy = this.requests.policy;
    const helloDeadline = setTimeout(() => {
      if (!c.welcomed) ws.close(1008, "hello required");
    }, this.requests.helloms);
    const ping = setInterval(() => this.#send(c, { t: "ping" }), policy.pingms);
    const silent = () => ws.close(1001, "heartbeat timeout");
    let silenceDeadline = setTimeout(silent, policy.silencems);
    const refresh = () => {
      clearTimeout(silenceDeadline);
      silenceDeadline = setTimeout(silent, policy.silencems);
    };
    const dispose = () => {
      if (!this.#connections.delete(c)) return;
      clearTimeout(helloDeadline);
      clearTimeout(silenceDeadline);
      clearInterval(ping);
      controller.abort();
      this.requests.coordinator.detach(recipient);
      const errors: unknown[] = [];
      for (const release of releases) {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
      releases.clear();
      for (const id of c.sessions) {
        try {
          this.#subscribe(c, id, false);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Session unsubscribe failed");
      }
    };
    ws.onclose = dispose;
    ws.onmessage = async (event) => {
      if (!this.#connections.has(c)) return;
      let ref: RequestRef | undefined;
      try {
        if (typeof event.data !== "string") {
          throw new HarnessError("frame", "Invalid frame");
        }
        const raw = object(JSON.parse(event.data)),
          frame = raw as unknown as ClientFrame;
        if (frame.t === "request") ref = requestRef(raw.ref);
        try {
          checkClientFrameSize(event.data);
        } catch (cause) {
          const failure = new ExecutionFailure({
            code: "request.capacity",
            retry: "new-intent",
          });
          failure.cause = cause;
          throw failure;
        }
        refresh();
        if (!c.welcomed) {
          if (frame.t !== "hello" || frame.protocol !== PROTOCOL_VERSION) {
            this.#send(c, { t: "error", code: "protocol" });
            ws.close(1002, "protocol mismatch");
            return;
          }
          if (welcoming) return;
          welcoming = true;
          principal = this.requests.identity();
          const identity = await requestFingerprint(`principal:${principal}`);
          if (!this.#connections.has(c)) return;
          const snapshot = this.index.snapshot();
          c.welcomed = true;
          clearTimeout(helloDeadline);
          this.#send(c, {
            t: "welcome",
            protocol: PROTOCOL_VERSION,
            messages: this.messages,
            requests: {
              window: this.requests.coordinator.window(),
              policy,
              principal: identity,
            },
            sidecar: {
              version: SIDECAR_VERSION,
              harness: {
                kind: this.backend.core.kind,
                version: this.backend.core.version,
                url: this.url,
                capabilities: capabilityNames(this.backend.capabilities),
              },
            },
          });
          this.#send(c, { t: "harness", state: this.harnessState });
          this.#send(c, snapshot);
          this.#send(c, { t: "prefs", prefs: this.prefs.get() });
          for (const source of this.sources) this.#send(c, source.snapshot());
          return;
        }
        if (frame.t === "pong") return;
        if (frame.t === "subscribe" || frame.t === "unsubscribe") {
          this.#subscribe(c, sessionID(raw)!, frame.t === "subscribe");
        } else if (frame.t === "resnapshot") {
          this.#send(c, this.index.snapshot());
        } else if (
          ["request", "request.resume", "request.release", "request.received"]
            .includes(frame.t)
        ) {
          await this.requests.coordinator.accept(
            principal,
            frame as RequestControl,
            recipient,
          );
        } else throw new HarnessError("frame", "Unknown frame");
      } catch (cause) {
        if (ref) {
          this.#send(c, {
            t: "request.rejected",
            ref,
            error: publicFailure(
              cause,
              (id, error) => console.warn("request admission", id, error),
            ),
          });
        } else this.#send(c, { t: "error", code: "frame" });
      }
    };
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [],
      attempt = (release: () => void) => {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      };
    for (const stop of this.#stops.splice(0).reverse()) attempt(stop);
    for (const source of this.sources) attempt(() => source.close?.());
    for (const c of this.#connections) {
      attempt(() => c.close());
      attempt(() => c.ws.close(1001, "server stopping"));
    }
    if (errors.length) {
      throw new AggregateError(errors, "Connection cleanup failed");
    }
  }
}
