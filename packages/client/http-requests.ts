// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ClientRequestPolicy,
  IntentIdentity,
  RequestControl,
  RequestEvent,
} from "@otk/protocol";
import { RequestTracker } from "./requests.ts";
import type { Operation, RequestOptions } from "./requests.ts";
import type { RequestTrackerOptions } from "./requests.ts";
export interface HttpRequestsOptions {
  base: URL;
  fetcher?: typeof fetch;
  clientID?: string;
  policy?: Pick<ClientRequestPolicy, "httpms" | "retrybase" | "retrymax">;
  diagnostic?: (cause: unknown) => void;
  tracker?: RequestTracker;
  kind?: RequestTrackerOptions["kind"];
}
interface Delivery {
  secret: string;
  ref: IntentIdentity;
  path: string;
  input: unknown;
  get: boolean;
  accepted: boolean;
  after: number;
  controller: AbortController;
  work?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  attempt: number;
  stopped: boolean;
  again?: boolean;
}
/** HTTP event transport over the same tracker as WS; no completion deadline. */
export class HttpRequests {
  readonly tracker: RequestTracker;
  #deliveries = new Map<string, Delivery>();
  #policy?: HttpRequestsOptions["policy"];
  constructor(readonly options: HttpRequestsOptions) {
    this.#policy = options.policy;
    this.tracker = options.tracker ?? new RequestTracker({
      send: (control) => this.send(control),
      clientID: options.clientID,
      server: options.base.href,
      diagnostic: options.diagnostic,
      kind: options.kind,
    });
    if (!options.tracker) {
      this.tracker.connect({
        id: "bootstrap",
        expiresAt: Number.MAX_SAFE_INTEGER,
      }, 1);
    }
  }
  policy(value: NonNullable<HttpRequestsOptions["policy"]>): void {
    this.#policy = value;
  }
  start<R>(
    path: string,
    input?: unknown,
    options: RequestOptions = {},
  ): Operation<R> {
    const ref = options.intent ??
      {
        clientID: this.tracker.clientID,
        key: crypto.randomUUID(),
        window: "bootstrap",
      };
    if (!this.#deliveries.has(ref.key)) {
      this.#deliveries.set(ref.key, {
        secret: Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join(""),
        ref,
        path,
        input,
        get: input === undefined,
        accepted: false,
        after: 0,
        controller: new AbortController(),
        attempt: 0,
        stopped: false,
      });
    }
    return this.tracker.capture(`bootstrap.${path}`, input ?? null, {
      ...options,
      intent: ref,
    }) as Operation<R>;
  }
  send(control: RequestControl): void {
    if (control.t === "request") this.#run(control.ref.key, control.ref.id);
    else if (control.t === "request.resume") {
      for (const { ref, after } of control.items) {
        const delivery = this.#deliveries.get(ref.key);
        if (delivery) {
          delivery.after = after;
        }
        this.#run(ref.key, ref.id);
      }
    } else {for (const value of control.refs) {
        const ref = "ref" in value ? value.ref : value;
        const delivery = this.#deliveries.get(ref.key);
        if (!delivery) continue;
        delivery.stopped = true;
        delivery.controller.abort();
        clearTimeout(delivery.retry);
        delivery.input = undefined;
        this.#deliveries.delete(ref.key);
      }}
  }
  #run(key: string, id: string): void {
    const delivery = this.#deliveries.get(key);
    if (!delivery || delivery.stopped) return;
    if (delivery.work) {
      delivery.again = true;
      return;
    }
    clearTimeout(delivery.retry);
    const fetcher = this.options.fetcher ?? fetch;
    const ref = { ...delivery.ref, id };
    const run = async () => {
      let liveness: ReturnType<typeof setTimeout> | undefined;
      const observe = () => {
        clearTimeout(liveness);
        if (this.#policy) {
          liveness = setTimeout(
            () => this.tracker.connectionFor(ref.key, "reconnecting"),
            this.#policy.httpms,
          );
        }
      };
      observe();
      try {
        if (!delivery.accepted) {
          const headers = new Headers({ "X-OTK-Receipt": delivery.secret });
          if (delivery.get) headers.set("X-OTK-Request", JSON.stringify(ref));
          else headers.set("Content-Type", "application/json");
          // Once sent, a lost admission response is reconciled by receipt. Never
          // automatically submit credential/setup input again after uncertainty.
          delivery.accepted = true;
          const response = await fetcher(
            new URL(delivery.path, this.options.base),
            {
              method: delivery.get ? "GET" : "POST",
              credentials: "include",
              cache: "no-store",
              headers,
              body: delivery.get
                ? undefined
                : JSON.stringify({ ref, input: delivery.input }),
              signal: delivery.controller.signal,
            },
          );
          if (delivery.stopped) {
            await response.body?.cancel().catch(() => {});
            return;
          }
          const event: RequestEvent = await response.json();
          this.tracker.connectionFor(ref.key, "connected");
          this.tracker.receive(event);
          if (event.t !== "request.accepted") return;
          delivery.accepted = true;
          delivery.after = event.seq;
        }
        observe();
        const response = await fetcher(
          new URL("request-events", this.options.base),
          {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              "X-OTK-Receipt": delivery.secret,
            },
            body: JSON.stringify({ ref, after: delivery.after }),
            signal: delivery.controller.signal,
          },
        );
        if (!response.ok) {
          const event: RequestEvent = await response.json();
          if (event.t === "request.rejected") {
            this.tracker.receive(event);
            return;
          }
          throw new Error("Request event transport unavailable");
        }
        if (!response.body) {
          throw new Error("Request event transport unavailable");
        }
        const reader = response.body.pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += chunk.value;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.trim()) continue;
              const event: RequestEvent = JSON.parse(line);
              observe();
              this.tracker.connectionFor(ref.key, "connected");
              if ("seq" in event) delivery.after = event.seq;
              this.tracker.receive(event);
              if (
                event.t === "request.result" || event.t === "request.rejected"
              ) return;
            }
          }
          if (!delivery.stopped) {
            throw new Error("Request event transport ended before result");
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally {
        clearTimeout(liveness);
      }
    };
    delivery.work = Promise.resolve().then(run).catch((cause) => {
      if (delivery.stopped) return;
      this.options.diagnostic?.(cause);
      this.tracker.connectionFor(ref.key, "reconnecting");
      if (this.#policy) {
        const delay = Math.min(
          this.#policy.retrymax,
          this.#policy.retrybase * 2 ** Math.min(delivery.attempt++, 30),
        );
        delivery.retry = setTimeout(
          () => this.#run(key, crypto.randomUUID()),
          delay,
        );
      }
    }).finally(() => {
      delivery.work = undefined;
      if (delivery.again && !delivery.stopped) {
        delivery.again = false;
        this.#run(key, crypto.randomUUID());
      }
    });
  }
  async stop(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const delivery of this.#deliveries.values()) {
      delivery.stopped = true;
      delivery.controller.abort();
      clearTimeout(delivery.retry);
      if (delivery.work) work.push(delivery.work);
    }
    if (!this.options.tracker) this.tracker.stop();
    await Promise.all(work);
    this.#deliveries.clear();
  }
}
