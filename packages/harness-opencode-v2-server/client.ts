// SPDX-License-Identifier: LGPL-3.0-only
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { HarnessError } from "@otk/harness";
import { OperationFailure } from "@otk/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DiscoveredService } from "./discovery.ts";
import { serviceHeaders } from "./discovery.ts";

export class V2MissingSession extends HarnessError {
  constructor() {
    super("session", "That session is no longer available.");
  }
}
/** One endpoint generation. Re-discovery replaces this owner, never the service. */
export class V2Client {
  readonly #api: OpenCodeClient;
  readonly #reads = new AsyncLocalStorage<AbortSignal>();
  constructor(
    readonly service: DiscoveredService,
    readonly requestms: number,
    readonly signal: AbortSignal,
    readonly fetcher: typeof fetch = fetch,
  ) {
    this.#api = OpenCode.make({
      baseUrl: service.endpoint.url,
      headers: serviceHeaders(service.endpoint),
      fetch: async (input, init) => {
        // All SDK calls in this owner are finite reads. Mutations get their
        // own classified effect owner when capabilities are selected.
        const response = await fetcher(input, {
          ...init,
          signal: AbortSignal.any([
            signal,
            ...(this.#reads.getStore() ? [this.#reads.getStore()!] : []),
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(requestms),
          ]),
        });
        if (response.status === 401) {
          await response.body?.cancel();
          throw new HarnessError(
            "authentication",
            "Opencode authentication failed (401).",
          );
        }
        return response;
      },
    });
  }
  /** All finite native reads share cancellation and certainty at this boundary. */
  async read<T>(
    run: (api: OpenCodeClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    try {
      const value = await this.#reads.run(
        signal ?? this.signal,
        () => run(this.#api),
      );
      this.signal.throwIfAborted();
      signal?.throwIfAborted();
      return value;
    } catch (cause) {
      this.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (cause instanceof OperationFailure || cause instanceof HarnessError) {
        throw cause;
      }
      if (cause instanceof Error && cause.cause instanceof HarnessError) {
        throw cause.cause;
      }
      const tag = cause && typeof cause === "object"
        ? Reflect.get(cause, "_tag")
        : undefined;
      if (tag === "SessionNotFoundError") throw new V2MissingSession();
      if (tag === "UnauthorizedError") {
        throw new HarnessError(
          "authentication",
          "Opencode authentication failed (401).",
        );
      }
      if (tag === "InvalidRequestError" || tag === "InvalidCursorError") {
        throw new OperationFailure("rejected", "native.rejected", cause);
      }
      // Transport, timeout, incompatible bodies and unknown errors cannot prove
      // absence or input rejection. In particular, never return an empty read.
      throw new OperationFailure("unavailable", "native.unavailable", cause);
    }
  }
}
export type { OpenCodeClient } from "@opencode/client";
