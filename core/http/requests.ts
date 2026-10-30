// SPDX-License-Identifier: LGPL-3.0-only
import { requestFingerprint, requestRef } from "@otk/protocol";
import type { RequestEvent, RequestRef } from "@otk/protocol";
import { RequestCoordinator } from "../requests/coordinator.ts";
import type {
  CoordinatorOptions,
  RequestRecipient,
} from "../requests/coordinator.ts";
import { VolatileRequests } from "../requests/volatile.ts";

interface Secret {
  hash: string;
  expires: number;
  principal: string;
  ref: RequestRef;
}
export interface HttpRequestOptions
  extends Omit<CoordinatorOptions, "receipts" | "bootstrap" | "fingerprint"> {
  /** Cookie-bearing terminal deliveries wait before response headers are sent. */
  resultHeaders?: (
    ref: RequestRef,
    event: Extract<RequestEvent, { t: "request.result" }>,
  ) => HeadersInit | undefined;
}
const identity = (origin: string, ref: RequestRef) =>
  JSON.stringify([origin, ref.clientID, ref.key]);
const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/x-ndjson",
};
export class HttpRequestAdapter {
  readonly coordinator: RequestCoordinator;
  #secrets = new Map<string, Secret>();
  #receipts: VolatileRequests;
  constructor(readonly options: HttpRequestOptions) {
    const now = (options.clock ?? Date.now)();
    this.#receipts = new VolatileRequests(now + options.policy.windowms);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const hmac = crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    this.coordinator = new RequestCoordinator({
      ...options,
      receipts: this.#receipts,
      bootstrap: true,
      fingerprint: async (canonical) => {
        const bytes = await crypto.subtle.sign(
          "HMAC",
          await hmac,
          new TextEncoder().encode(canonical),
        );
        return Array.from(
          new Uint8Array(bytes),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      },
    });
  }
  start(): Promise<void> {
    return this.coordinator.start();
  }
  stop(): Promise<void> {
    return this.coordinator.stop();
  }
  #recipient(send: (event: RequestEvent) => void): RequestRecipient {
    return {
      send,
      lease: {
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        defer() {},
      },
    };
  }
  async #authorized(
    ref: RequestRef,
    secret: string,
    origin: string,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/i.test(secret)) return false;
    const receipt = this.#secrets.get(identity(origin, ref));
    return !!receipt &&
      (!this.#expired(receipt, (this.options.clock ?? Date.now)())) &&
      receipt.hash === await requestFingerprint(secret);
  }
  #expired(receipt: Secret, now: number): boolean {
    if (receipt.expires > now) return false;
    const record = this.#receipts.get({
      principal: receipt.principal,
      client_id: receipt.ref.clientID,
      intent_key: receipt.ref.key,
    });
    return !record ||
      ["succeeded", "failed", "released"].includes(record.state);
  }
  async admit(
    method: string,
    inputRef: RequestRef,
    input: unknown,
    secret: string,
    origin: string,
  ): Promise<Response> {
    const ref = requestRef(inputRef, true);
    if (!/^[a-f0-9]{64}$/i.test(secret)) {
      return new Response(null, { status: 403, headers });
    }
    const id = identity(origin, ref), previous = this.#secrets.get(id);
    const hash = await requestFingerprint(secret);
    if (previous && previous.hash !== hash) {
      return new Response(null, { status: 403, headers });
    }
    const now = (this.options.clock ?? Date.now)();
    if (!previous) {
      for (const [key, value] of this.#secrets) {
        if (this.#expired(value, now)) this.#secrets.delete(key);
      }
      if (this.#secrets.size >= this.options.policy.maxpending) {
        return Response.json({
          t: "request.rejected",
          ref,
          error: {
            code: "request.capacity",
            retry: "same-intent",
            diagnosticID: crypto.randomUUID(),
          },
        }, { status: 429, headers });
      }
      this.#secrets.set(id, {
        hash,
        principal: origin,
        ref,
        expires: now + this.options.policy.windowms +
          this.options.policy.retentionms,
      });
    }
    if (ref.window === "bootstrap") {
      this.#receipts.renewBootstrap(now, this.options.policy.windowms);
    }
    let first: RequestEvent | undefined;
    const recipient = this.#recipient((event) => {
      first ??= event;
    });
    await this.coordinator.accept(origin, {
      t: "request",
      ref,
      method,
      params: input,
    }, recipient);
    this.coordinator.detach(recipient);
    if (!first) throw new Error("Missing HTTP admission event");
    return Response.json(first, {
      status: first.t === "request.rejected" ? 400 : 202,
      headers,
    });
  }
  async events(
    inputRef: RequestRef,
    after: number,
    secret: string,
    origin: string,
  ): Promise<Response> {
    const ref = requestRef(inputRef, true);
    if (
      !Number.isSafeInteger(after) || after < 0 ||
      !await this.#authorized(ref, secret, origin)
    ) {
      return Response.json({
        t: "request.rejected",
        ref,
        error: {
          code: "request.receipt-reset",
          retry: "none",
          diagnosticID: crypto.randomUUID(),
        },
      }, { status: 403, headers });
    }
    let recipient: RequestRecipient;
    if (this.options.resultHeaders) {
      const event = await new Promise<RequestEvent>((resolve, reject) => {
        recipient = this.#recipient((event) => {
          if (event.t === "request.result" || event.t === "request.rejected") {
            resolve(event);
          }
        });
        void this.coordinator.accept(origin, {
          t: "request.resume",
          items: [{ ref, after }],
        }, recipient).catch(reject);
      });
      this.coordinator.detach(recipient!);
      const record = this.#receipts.get({
        principal: origin,
        client_id: ref.clientID,
        intent_key: ref.key,
      });
      const snapshot = event.t === "request.result" && record
        ? JSON.stringify({
          t: "request.accepted",
          ref,
          seq: event.seq,
          acceptedAt: record.accepted_at,
          retentionUntil: record.retention_until,
          replayed: true,
        }) + "\n"
        : "";
      return new Response(snapshot + JSON.stringify(event) + "\n", {
        headers: {
          ...headers,
          ...Object.fromEntries(
            new Headers(
              event.t === "request.result" && event.outcome.ok
                ? this.options.resultHeaders(ref, event)
                : undefined,
            ),
          ),
        },
      });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        recipient = this.#recipient((event) => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          if (event.t === "request.result" || event.t === "request.rejected") {
            controller.close();
            this.coordinator.detach(recipient);
          }
        });
        void this.coordinator.accept(origin, {
          t: "request.resume",
          items: [{ ref, after }],
        }, recipient).catch((cause) => controller.error(cause));
      },
      cancel: () => this.coordinator.detach(recipient),
    });
    return new Response(stream, { headers });
  }
}
