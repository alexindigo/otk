// SPDX-License-Identifier: LGPL-3.0-only
import {
  capabilityNames,
  checkClientFrameSize,
  isAttentionOp,
  isSessionID,
  MAX_UPLOAD_BYTES,
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
  IndexEntry,
  MessagePolicy,
  Preferences,
  RequestControl,
  RequestEvent,
  RequestRef,
  ServerFrame,
  ViewLease,
} from "@otk/protocol";
import { type Harness, HarnessError } from "@otk/harness";
import type { Prefs } from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import { IndexView } from "../index/view.ts";
import { object, sessionID } from "./params.ts";
import type { RpcRegistry } from "./registry.ts";
import type { SectionObserver } from "../diagnostics.ts";
import type { RequestCoordinator } from "../requests/coordinator.ts";
import { ExecutionFailure, publicFailure } from "../requests/failures.ts";

interface Connection {
  ws: WebSocket;
  welcomed: boolean;
  sessions: Set<string>;
  view: ViewLease;
  index: IndexView;
  sources: readonly FrameSource[];
  close(): void;
}
export interface FrameSource {
  /** Refresh connection-owned demand before admitting work for a changed view. */
  viewChanged?(): void;
  /** Feature-owned connection projection, with its own local revisions. */
  open?(
    view: () => ViewLease,
    id: string,
    entries: () => ReadonlySet<string>,
  ): FrameSource;
  keys?(view: ViewLease): readonly string[];
  project?(entry: IndexEntry, view: ViewLease): IndexEntry;
  snapshot?(signal?: AbortSignal): ServerFrame | Promise<ServerFrame>;
  listen(listener: (frame: ServerFrame) => void): () => void;
  close?(): void;
}
export interface ConnectionRequests {
  coordinator: RequestCoordinator;
  identity(): string;
  policy: ClientRequestPolicy;
  helloms: number;
  attachments?: import("@otk/protocol").AttachmentPolicy;
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
      this.#stops.push(index.listen((frame) => {
        for (const c of this.#connections) {
          if (c.welcomed) c.index.refresh(frame);
        }
      }));
      this.#stops.push(
        prefs.listen((prefs) => this.broadcast({ t: "prefs", prefs })),
      );
      for (const source of sources) {
        if (source.open) continue;
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
    this.#fanout(frame, (c) => c.welcomed);
  }
  #fanout(
    frame: ServerFrame,
    accepts: (connection: Connection) => boolean,
  ): void {
    let serialized: string | undefined;
    for (const connection of this.#connections) {
      if (!accepts(connection) || connection.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (serialized === undefined) {
        const start = performance.now();
        serialized = JSON.stringify(frame);
        this.diagnostics?.(`serialize:${frame.t}`, performance.now() - start);
      }
      connection.ws.send(serialized);
    }
  }
  connection(state: HarnessState): void {
    this.harnessState = state;
    this.broadcast({ t: "harness", state });
  }
  content(sessionID: string, event: ContentOp, clock?: ContentClock): void {
    // Attention routed to an ancestor depends on the child's metadata. Publish
    // that authority before the event, including newly acquired scoped entries.
    if (isAttentionOp(event)) this.index.flush();
    const recipients = isAttentionOp(event)
      ? [sessionID, ...this.index.ancestors(sessionID)]
      : [sessionID];
    this.#fanout({
      t: "content",
      sessionID,
      event,
      ...(clock ? { clock } : {}),
    }, (c) => c.welcomed && recipients.some((id) => c.sessions.has(id)));
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
      view: { epoch: 0, crumbs: [], rows: [] },
      index: undefined as unknown as IndexView,
      sources: [],
      close: () => dispose(),
    };
    this.#connections.add(c);
    const controller = new AbortController(), releases = new Set<() => void>();
    c.index = new IndexView(
      this.index,
      () => c.view,
      (view) => this.sources.flatMap((source) => source.keys?.(view) ?? []),
      (frame) => this.#send(c, frame),
      (entry, view) =>
        this.sources.reduce(
          (value, source) => source.project?.(value, view) ?? value,
          entry,
        ),
    );
    releases.add(() => c.index.close());
    const socketID = crypto.randomUUID();
    c.sources = this.sources.map((source) =>
      source.open?.(() => c.view, socketID, () => c.index.ids()) ?? source
    );
    for (let n = 0; n < c.sources.length; n++) {
      if (!this.sources[n].open) continue;
      const source = c.sources[n];
      releases.add(source.listen((frame) => {
        if (!c.welcomed) return;
        c.index.refresh();
        this.#send(c, { ...frame, epoch: c.view.epoch });
      }));
      if (source.close) releases.add(() => source.close!());
    }
    const view = (raw: Record<string, unknown>): ViewLease => {
      const list = (value: unknown): string[] => {
        if (!Array.isArray(value) || value.some((id) => !isSessionID(id))) {
          throw new HarnessError(
            "params",
            "Expected qualified view identities",
          );
        }
        return [...new Set(value)] as string[];
      };
      if (
        !Number.isSafeInteger(raw.epoch) || Number(raw.epoch) < 0 ||
        raw.directory !== undefined && typeof raw.directory !== "string" ||
        raw.selected !== undefined && !isSessionID(raw.selected) ||
        raw.query !== undefined && typeof raw.query !== "string"
      ) {
        throw new HarnessError("params", "Invalid view lease");
      }
      return {
        epoch: Number(raw.epoch),
        directory: raw.directory as string | undefined,
        selected: raw.selected as string | undefined,
        crumbs: list(raw.crumbs),
        rows: list(raw.rows),
        query: raw.query as string | undefined,
      };
    };
    const snapshots = async () => {
      const epoch = c.view.epoch;
      for (const source of c.sources) {
        if (!source.snapshot) continue;
        const frame = await source.snapshot(controller.signal);
        if (controller.signal.aborted || c.view.epoch !== epoch) return;
        this.#send(c, { ...frame, epoch });
      }
    };
    let selectionGeneration = 0;
    const changed = () => {
      for (const source of c.sources) source.viewChanged?.();
    };
    const settle = () => {
      if (controller.signal.aborted || c.view.pageSettled) return;
      c.view = { ...c.view, pageSettled: true };
      changed();
    };
    const lease = {
      id: socketID,
      view: () => c.view,
      entries: () => c.index.ids(),
      signal: controller.signal,
      firstPage(sessionID: string) {
        const generation = selectionGeneration;
        return () => {
          if (
            generation === selectionGeneration && c.view.selected === sessionID
          ) settle();
        };
      },
      defer(release: () => void) {
        if (controller.signal.aborted) release();
        else releases.add(release);
        return () => {
          releases.delete(release);
        };
      },
      publish: (frame: ServerFrame) => this.#send(c, frame),
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
          if (raw.view) c.view = view(object(raw.view));
          selectionGeneration++;
          changed();
          this.index.flush();
          c.welcomed = true;
          clearTimeout(helloDeadline);
          this.#send(c, {
            t: "welcome",
            protocol: PROTOCOL_VERSION,
            messages: this.messages,
            ...(this.requests.attachments
              ? {
                attachments: {
                  ...this.requests.attachments,
                  uploadbytes: MAX_UPLOAD_BYTES,
                },
              }
              : {}),
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
          c.index.snapshot();
          this.#send(c, { t: "prefs", prefs: this.prefs.get() });
          await snapshots();
          return;
        }
        if (frame.t === "pong") return;
        if (frame.t === "view.settled") {
          if (
            !Number.isSafeInteger(frame.epoch) || !isSessionID(frame.sessionID)
          ) {
            throw new HarnessError("params", "Invalid first-page settlement");
          }
          if (
            frame.epoch === c.view.epoch && frame.sessionID === c.view.selected
          ) settle();
          return;
        }
        if (frame.t === "index.applied") {
          if (
            !Number.isSafeInteger(frame.epoch) ||
            !Number.isSafeInteger(frame.rev) || frame.epoch < 0 || frame.rev < 0
          ) {
            throw new HarnessError("params", "Invalid applied index revision");
          }
          c.index.applied(frame.epoch, frame.rev);
          return;
        }
        if (frame.t === "view") {
          const next = view(raw);
          if (next.epoch <= c.view.epoch) return;
          this.index.flush();
          if (next.selected !== c.view.selected) selectionGeneration++;
          c.view = {
            ...next,
            pageSettled: next.selected === c.view.selected &&
              c.view.pageSettled,
          };
          changed();
          c.index.refresh();
          await snapshots();
        } else if (frame.t === "subscribe" || frame.t === "unsubscribe") {
          this.#subscribe(c, sessionID(raw)!, frame.t === "subscribe");
        } else if (frame.t === "resnapshot") {
          c.index.snapshot();
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
