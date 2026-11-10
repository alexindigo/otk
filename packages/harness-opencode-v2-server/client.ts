// SPDX-License-Identifier: LGPL-3.0-only
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { HarnessError, NativeReadiness } from "@otk/harness";
import { type OperationContext, OperationFailure } from "@otk/protocol";
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
  readonly readiness: NativeReadiness;
  readonly #api: OpenCodeClient;
  readonly #reads = new AsyncLocalStorage<AbortSignal>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #tails = new Map<string, Promise<unknown>>();
  /** One same-session sequence, including its prepared inputs and terminal read. */
  sequence<T>(
    sessionID: string,
    run: () => Promise<T>,
    operation?: OperationContext,
  ): Promise<T> {
    const prior = this.#tails.get(sessionID) ?? Promise.resolve();
    const task = this.#own((async () => {
      const ready = prior.catch(() => {});
      await (operation?.wait ? operation.wait(ready) : ready);
      this.signal.throwIfAborted();
      operation?.signal.throwIfAborted();
      return await run();
    })());
    this.#tails.set(sessionID, task);
    void task.finally(() => {
      if (this.#tails.get(sessionID) === task) this.#tails.delete(sessionID);
    }).catch(() => {});
    return task;
  }
  #own<T>(pending: Promise<T>): Promise<T> {
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  async join(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
  readonly #effects = new AsyncLocalStorage<{
    operation?: OperationContext;
    dispatched: boolean;
    observation?: boolean;
  }>();
  /** The stream aborts this generation first, then joins its actual SDK I/O. */
  async idle(): Promise<void> {
    await this.join();
  }
  constructor(
    readonly service: DiscoveredService,
    readonly requestms: number,
    readonly signal: AbortSignal,
    readonly fetcher: typeof fetch = fetch,
    readonly admission?: (signal: AbortSignal) => Promise<() => void>,
    readonly wait: <T>(value: Promise<T>, join?: boolean) => Promise<T> = (
      value,
    ) => value,
  ) {
    this.readiness = new NativeReadiness(wait, admission);
    this.#api = OpenCode.make({
      baseUrl: service.endpoint.url,
      headers: serviceHeaders(service.endpoint),
      fetch: async (input, init) => {
        const effect = this.#effects.getStore();
        signal.throwIfAborted();
        effect?.operation?.signal.throwIfAborted();
        if (effect && !effect.observation) {
          await effect.operation?.beforeEffect();
          effect.dispatched = true;
        }
        const response = await fetcher(input, {
          ...init,
          signal: AbortSignal.any([
            signal,
            ...(this.#reads.getStore() ? [this.#reads.getStore()!] : []),
            ...(init?.signal ? [init.signal] : []),
            ...(effect
              ? effect.operation ? [effect.operation.signal] : []
              : [AbortSignal.timeout(requestms)]),
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
  /** Classified dispatch has lifecycle cancellation, never a mutation deadline. */
  effect<T>(
    run: (api: OpenCodeClient) => Promise<T>,
    operation?: OperationContext,
  ): Promise<T>;
  effect<T>(
    run: (api: OpenCodeClient) => Promise<T>,
    operation: OperationContext | undefined,
    settled: readonly string[],
  ): Promise<T | undefined>;
  async effect<T>(
    run: (api: OpenCodeClient) => Promise<T>,
    operation?: OperationContext,
    settled: readonly string[] = [],
  ): Promise<T | undefined> {
    this.signal.throwIfAborted();
    operation?.signal.throwIfAborted();
    const context = { operation, dispatched: false };
    try {
      const exchange = this.#own(
        this.#effects.run(context, () => run(this.#api)),
      );
      const result =
        await (operation?.wait ? operation.wait(exchange) : exchange);
      this.signal.throwIfAborted();
      operation?.signal.throwIfAborted();
      return result;
    } catch (cause) {
      const tag = errorTag(cause);
      if (tag && settled.includes(tag)) return undefined;
      const known = nativeFailure(cause);
      if (known instanceof OperationFailure) throw known;
      if (
        known instanceof HarnessError ||
        tag &&
          /(?:Invalid|NotFound|Busy|Unauthorized|Validation|Denied|Conflict|AttachmentError)/
            .test(tag)
      ) {
        throw new OperationFailure("rejected", "native.rejected", cause);
      }
      if (!context.dispatched) throw cause;
      throw new OperationFailure("unknown", "native.unknown", cause);
    }
  }
  /** Native wait is a read-only POST; it must outlive finite-read deadlines. */
  async settled(
    sessionID: string,
    operation?: OperationContext,
  ): Promise<void> {
    const exchange = this.#own(this.#effects.run(
      { operation, dispatched: false, observation: true },
      () => this.#api.experimental.session.wait({ sessionID }),
    ));
    try {
      await (operation?.wait ? operation.wait(exchange) : exchange);
    } catch (cause) {
      // An admitted mutation whose terminal cannot be observed stays uncertain.
      throw new OperationFailure("unknown", "native.unknown", cause);
    }
  }
  /** All finite native reads share cancellation and certainty at this boundary. */
  async read<T>(
    run: (api: OpenCodeClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    try {
      const value = await this.#own(this.readiness.run(
        AbortSignal.any([this.signal, ...(signal ? [signal] : [])]),
        () => this.#reads.run(signal ?? this.signal, () => run(this.#api)),
      ));
      this.signal.throwIfAborted();
      signal?.throwIfAborted();
      return value;
    } catch (cause) {
      this.signal.throwIfAborted();
      signal?.throwIfAborted();
      const known = nativeFailure(cause);
      if (known) throw known;
      const tag = errorTag(cause);
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
export function errorTag(cause: unknown): string | undefined {
  for (const value of causes(cause)) {
    const tag = Reflect.get(value, "_tag");
    if (typeof tag === "string") return tag;
  }
}
function nativeFailure(
  cause: unknown,
): OperationFailure | HarnessError | undefined {
  for (const value of causes(cause)) {
    if (value instanceof OperationFailure || value instanceof HarnessError) {
      return value;
    }
  }
}
function* causes(cause: unknown): Generator<object> {
  const seen = new Set<object>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    yield cause;
    cause = Reflect.get(cause, "cause");
  }
}
export type { OpenCodeClient } from "@opencode/client";
