// SPDX-License-Identifier: LGPL-3.0-only
import {
  canonicalRequest,
  checkClientFrameSize,
  createRequestMetadata,
} from "@otk/protocol";
import type {
  ClientFrame,
  IntentIdentity,
  RequestEvent,
  RequestMetadataRegistry,
  RpcMethod,
  RpcParams,
  RpcResult,
  ServerFrame,
} from "@otk/protocol";
import {
  IntentGroups,
  type Operation,
  type RequestOptions,
  RequestTracker,
} from "./requests.ts";
import { RequestFailure } from "./failures.ts";
import type { FeedbackOwner } from "./failures.ts";
import { createRequestFeedback } from "./failure-features.ts";
/** Optional object properties are absent on JSON wire; invalid array values remain strict. */
function wireParams(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    value.forEach((item, index) => {
      out[index] = wireParams(item, seen);
    });
    out.length = value.length;
    return out;
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      Object.defineProperty(out, key, {
        value: wireParams(item, seen),
        enumerable: true,
      });
    }
  }
  return out;
}
/** Typed facade only. A socket close or elapsed interval never settles work. */
export class Rpc {
  readonly requests: RequestTracker;
  readonly intents: IntentGroups = new IntentGroups(() => this.intent());
  readonly metadata: RequestMetadataRegistry = createRequestMetadata();
  #feedback = new Map<string, FeedbackOwner>();
  feedback(owner: string): FeedbackOwner {
    let feedback = this.#feedback.get(owner);
    if (!feedback) {
      feedback = createRequestFeedback(this.requests, owner, this.metadata);
      this.#feedback.set(owner, feedback);
    }
    return feedback;
  }
  constructor(
    readonly send: (frame: ClientFrame) => void,
    requests?: RequestTracker,
  ) {
    const metadata = createRequestMetadata();
    this.requests = requests ??
      new RequestTracker({
        send,
        kind: (method) => metadata.get(method)?.kind ?? "mutation",
      });
  }
  intent(): IntentIdentity {
    return this.requests.intent();
  }
  start<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options: RequestOptions = {},
  ): Operation<RpcResult<M>> {
    const fields = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    const owner = options.owner ??
      (typeof fields.sessionID === "string"
        ? fields.sessionID
        : typeof fields.directory === "string"
        ? fields.directory
        : undefined);
    options = { ...options, owner };
    if (owner && this.metadata.get(method)?.kind === "mutation") {
      this.requests.forgetFailures(owner, method);
      this.#feedback.get(owner)?.clear();
    }
    const intent = options.intent ?? this.intent();
    let captured: RpcParams<M>;
    try {
      captured = JSON.parse(canonicalRequest(wireParams(params))) as RpcParams<
        M
      >;
    } catch (cause) {
      const failure = new RequestFailure({
        code: "request.params",
        retry: "new-intent",
        diagnosticID: crypto.randomUUID(),
      });
      failure.cause = cause;
      throw failure;
    }
    try {
      checkClientFrameSize(
        JSON.stringify({
          t: "request",
          ref: {
            ...intent,
            window: intent.window || crypto.randomUUID(),
            id: crypto.randomUUID(),
          },
          method,
          params: captured,
        }),
      );
    } catch (cause) {
      const failure = new RequestFailure({
        code: "request.capacity",
        retry: "new-intent",
        diagnosticID: crypto.randomUUID(),
      });
      failure.cause = cause;
      throw failure;
    }
    return this.requests.start(method, captured, { ...options, intent });
  }
  call<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    signalOrOptions?: AbortSignal | RequestOptions,
  ): Promise<RpcResult<M>> {
    try {
      return this.start(
        method,
        params,
        signalOrOptions instanceof AbortSignal
          ? { signal: signalOrOptions }
          : signalOrOptions,
      ).result;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  receive(frame: ServerFrame | RequestEvent): void {
    if (
      frame.t === "request.accepted" || frame.t === "request.progress" ||
      frame.t === "request.result" || frame.t === "request.rejected"
    ) this.requests.receive(frame);
  }
  close(): void {
    this.requests.disconnect();
  }
}
