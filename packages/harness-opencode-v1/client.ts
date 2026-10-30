// SPDX-License-Identifier: LGPL-3.0-only
import type { OpencodeV1Config } from "./config.ts";
import { HarnessError } from "@otk/harness";
import { errorMessage } from "@otk/protocol";
import { finiteResponse } from "./finite-response.ts";
import { NativeReadiness } from "./readiness.ts";
import {
  type OperationContext,
  OperationFailure,
  type PublicFailure,
} from "@otk/protocol";

export interface NativeRequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  stream?: boolean;
  timeout?: number | null;
  classification?: "read" | "effect" | "stream";
  operation?: OperationContext;
}
export class NativeRequestFailure extends OperationFailure {
  readonly failure: PublicFailure;
  constructor(
    outcome: "unknown" | "unavailable" | "rejected",
    readonly original: unknown,
    code: string,
  ) {
    super(outcome, code, original);
    this.failure = {
      code,
      retry: outcome === "unknown"
        ? "none"
        : outcome === "unavailable"
        ? "same-intent"
        : "new-intent",
      diagnosticID: crypto.randomUUID(),
    };
  }
}
function classifyNative(
  cause: unknown,
  classification: NativeRequestOptions["classification"],
): NativeRequestFailure {
  if (cause instanceof NativeRequestFailure) return cause;
  if (
    cause instanceof HttpFailure && cause.status >= 400 && cause.status < 500
  ) {
    const code = cause.detail.kind === "SessionBusyError"
      ? "session.busy"
      : cause.status === 404
      ? "resource.missing"
      : "native.rejected";
    return new NativeRequestFailure("rejected", cause, code);
  }
  return classification === "effect"
    ? new NativeRequestFailure("unknown", cause, "native.unknown")
    : new NativeRequestFailure("unavailable", cause, "native.unavailable");
}
// Native diagnostics name opaque resources; display copy never interpolates them.
const nativeMessages = new Map<string, string>([
  ["SessionBusyError", "The session is working. Try again when it finishes."],
  ["MessageNotFoundError", "That message is no longer in the session."],
  ["SessionNotFoundError", "That session is no longer available."],
  ["PermissionNotFoundError", "That permission request is no longer pending."],
  ["QuestionNotFoundError", "That question is no longer pending."],
  ["PtyNotFoundError", "That terminal is no longer available."],
  ["ProjectNotFoundError", "That project is no longer available."],
  ["ProviderNotFoundError", "That provider is no longer available."],
  ["ModelNotFoundError", "That model is no longer available."],
  ["McpServerNotFoundError", "That MCP server is no longer available."],
]);
function displayMessage(
  kind: string | undefined,
  reason: string,
  fallback: string,
  identities: string[],
): string {
  const mapped = nativeMessages.get(kind || "");
  if (mapped) return mapped;
  if (kind === "NotFoundError") {
    if (
      /^Message not found\b|^Resource not found: .*[/\\]message[/\\]/i.test(
        reason,
      )
    ) {
      return nativeMessages.get("MessageNotFoundError")!;
    }
    if (
      /^Part not found\b|^Resource not found: .*[/\\]part[/\\]/i.test(reason)
    ) {
      return "That message part is no longer in the session.";
    }
    if (
      /^Session not found\b|^Resource not found: .*[/\\]session[/\\]/i.test(
        reason,
      )
    ) {
      return nativeMessages.get("SessionNotFoundError")!;
    }
    return "The requested item is no longer available.";
  }
  // Characterized native Identifier prefixes, including identities absent from
  // the envelope. Unknown kinds still cannot leak them through fallback copy.
  return /(?:job|evt|ses|msg|per|que|prt|pty|tool|wrk)_[a-z0-9]+/i.test(
      reason,
    ) ||
      identities.some((id) => reason.includes(id))
    ? fallback
    : reason;
}
export class HttpFailure extends HarnessError {
  constructor(
    readonly status: number,
    readonly detail: { message: string; kind?: string; ref?: string },
    original?: unknown,
  ) {
    super(`harness_${status}`, detail.message.slice(0, 1024));
    this.cause = original;
  }
}
export class Client {
  readonly readiness: NativeReadiness;
  constructor(
    readonly cfg: OpencodeV1Config["harness"],
    readonly fetcher: typeof fetch = fetch,
    readonly wait: <T>(readiness: Promise<T>, join?: boolean) => Promise<T> = (
      readiness,
    ) => readiness,
    readonly admission?: (signal: AbortSignal) => Promise<() => void>,
  ) {
    this.readiness = new NativeReadiness(wait, admission);
  }
  url(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): URL {
    const url = new URL(this.cfg.url.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }
  async request(
    path: string,
    options: NativeRequestOptions = {},
  ): Promise<Response> {
    if (!options.classification) return await this.#request(path, options);
    const classification = options.classification;
    if (options.timeout !== undefined || options.stream !== undefined) {
      throw new TypeError("Classified requests use the injected native policy");
    }
    if (
      classification === "read" &&
      (!Number.isSafeInteger(this.cfg.requestms) || this.cfg.requestms! <= 0)
    ) throw new TypeError("Native read policy is required");
    const signal = options.operation
      ? options.signal
        ? AbortSignal.any([options.signal, options.operation.signal])
        : options.operation.signal
      : options.signal;
    try {
      return await this.#request(path, {
        ...options,
        signal,
        stream: classification === "stream",
        timeout: classification === "read" ? this.cfg.requestms : null,
      });
    } catch (cause) {
      throw classifyNative(cause, classification);
    }
  }
  async #request(
    path: string,
    options: NativeRequestOptions = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (this.cfg.password) {
      headers.set(
        "Authorization",
        `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
      );
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const read = async () => {
      // A native deadline begins at I/O admission, not while waiting for permission.
      let signal = options.signal;
      if (!options.stream && options.timeout !== null) {
        const deadline = AbortSignal.timeout(options.timeout ?? 15_000);
        signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      }
      signal?.throwIfAborted();
      if (options.classification === "effect") {
        await options.operation?.beforeEffect();
      }
      return this.fetcher(this.url(path, options.query), {
        method: options.method || "GET",
        headers,
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
        signal,
      }).then((value) =>
        (this.admission || options.classification) && !options.stream
          ? finiteResponse(value)
          : value
      );
    };
    const exchange = options.stream ? this.wait(read()) : this.readiness.run(
      options.signal ?? new AbortController().signal,
      read,
    );
    const response =
      await (options.operation?.wait
        ? options.operation.wait(exchange)
        : exchange);
    if (!response.ok) {
      const text = await this.wait(response.text());
      const fallback = `Request failed (HTTP ${response.status}).`;
      let message = text.trim() || fallback;
      let kind: string | undefined, ref: string | undefined;
      const identities: string[] = [];
      try {
        const value: unknown = JSON.parse(text);
        message = fallback;
        if (typeof value === "string" && value.trim()) {
          message = errorMessage(value);
        }
        if (value && typeof value === "object") {
          if ("_tag" in value && typeof value._tag === "string") {
            kind = value._tag;
          } else if ("name" in value && typeof value.name === "string") {
            kind = value.name;
          }
          const data = "data" in value ? value.data : undefined;
          for (const envelope of [value, data]) {
            if (!envelope || typeof envelope !== "object") continue;
            for (const [key, id] of Object.entries(envelope)) {
              if (
                /(?:ID$|^id$|^ref$)/.test(key) && typeof id === "string" && id
              ) {
                identities.push(id);
              }
            }
          }
          if (
            data && typeof data === "object" && "message" in data &&
            typeof data.message === "string" && data.message.trim()
          ) message = errorMessage(data);
          else if (
            "message" in value && typeof value.message === "string" &&
            value.message.trim()
          ) message = errorMessage(value);
          if (
            data && typeof data === "object" && "ref" in data &&
            typeof data.ref === "string"
          ) ref = data.ref;
          else if ("ref" in value && typeof value.ref === "string") {
            ref = value.ref;
          }
        }
      } catch { /* Non-JSON errors retain the existing HTTP text. */ }
      throw new HttpFailure(response.status, {
        message: displayMessage(kind, message, fallback, identities),
        ...(kind ? { kind } : {}),
        ...(ref ? { ref } : {}),
      }, text);
    }
    return response;
  }
  async json<T>(
    path: string,
    options: Parameters<Client["request"]>[1] = {},
  ): Promise<T> {
    try {
      const response = await this.request(path, options);
      return response.status === 204
        ? undefined as T
        : await this.wait(response.json());
    } catch (cause) {
      if (options.classification) {
        throw classifyNative(cause, options.classification);
      }
      throw cause;
    }
  }
}
