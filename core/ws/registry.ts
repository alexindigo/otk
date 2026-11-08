// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { OtkDb } from "@otk/store";
import type { IndexMetadata, RpcMethod, RpcResult } from "@otk/protocol";
import { object } from "./params.ts";
import type {
  PreparedRequest,
  RequestExecution,
  RpcExecutionPolicy,
} from "../requests/types.ts";

/** Shared resources; features own their validation and operation handlers. */
export interface RpcContext {
  harness: Harness;
  store: OtkDb;
  request?: RequestLifetime;
  execution?: RequestExecution;
  sessionMetadata?(sessionID: string): IndexMetadata | undefined;
  sessionDirectory(sessionID: string): Promise<string>;
  sessionDirectories(
    sessionIDs: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>>;
}
/** Socket-owned leases are distinct from a single read's execution signal. */
export interface RequestLifetime {
  /** Captured view generation: failure/cancellation settles only its own first page. */
  firstPage?(sessionID: string): () => void;
  view?(): import("@otk/protocol").ViewLease;
  entries?(): ReadonlySet<string>;
  id: string;
  signal: AbortSignal;
  defer(release: () => void): void | (() => void);
  publish?(frame: import("@otk/protocol").ServerFrame): void;
}
export interface RpcDefinition<P, R> {
  // Validation owns P. Policy factories consume it without widening handlers.
  execution?: RpcExecutionPolicy<NoInfer<P>, R>;
  cancelled?(
    params: NoInfer<P>,
    request?: RequestLifetime,
  ): (() => void) | undefined;
  params(value: Record<string, unknown>): P;
  handler(ctx: RpcContext, params: P): R | Promise<R>;
}
/** Dispatch has no knowledge of feature implementations or method names. */
export class RpcRegistry {
  #handlers = new Map<
    string,
    (p: Record<string, unknown>) => PreparedRequest
  >();
  readonly context: RpcContext;
  #policies = new Map<string, RpcExecutionPolicy<never, unknown>>();
  constructor(
    harness: Harness,
    store: OtkDb,
    readonly observe?: (owner: string, active: boolean) => void,
    readonly metadata?: (sessionID: string) => IndexMetadata | undefined,
  ) {
    this.context = {
      harness,
      store,
      sessionMetadata: (id) => this.metadata?.(id),
      sessionDirectories: (ids, signal) => this.#directories(ids, signal),
      sessionDirectory: async (id) => (await this.#directories([id]))[id],
    };
  }
  async #directories(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    signal?.throwIfAborted();
    const unique = [...new Set(ids)];
    if (!unique.length) return {};
    const rows = await this.context.harness.core.identities(unique, signal);
    signal?.throwIfAborted();
    const result = Object.fromEntries(
      rows.map((row) => [row.id, row.directory]),
    );
    if (unique.some((id) => !Object.hasOwn(result, id))) {
      throw new HarnessError("session", "That session is no longer available.");
    }
    return result;
  }
  register<M extends RpcMethod, P>(
    method: M,
    definition: RpcDefinition<P, RpcResult<M>>,
  ): void {
    if (this.#handlers.has(method)) {
      throw new HarnessError("method", `Method already registered: ${method}`);
    }
    this.#handlers.set(
      method,
      (raw) => {
        const params = definition.params(raw);
        return {
          execution: definition.execution,
          scope: definition.execution?.scope(params) ?? {},
          cancelled: (request) => definition.cancelled?.(params, request),
          run: async (execution, request) => {
            const owner = crypto.randomUUID();
            let finished = false, active = false, waiting = 0;
            const observe = (next: boolean) => {
              if (finished || active === next) return;
              active = next;
              this.observe?.(owner, next);
            };
            observe(true);
            const scoped = execution
              ? {
                ...execution,
                progress: (
                  value: Parameters<RequestExecution["progress"]>[0],
                ) => {
                  observe(value.phase === "running");
                  execution.progress(value);
                },
                wait: async <T>(ready: Promise<T>): Promise<T> => {
                  waiting++;
                  observe(false);
                  try {
                    return await (execution.wait?.(ready) ?? ready);
                  } finally {
                    if (--waiting === 0 && !execution.signal.aborted) {
                      observe(
                        true,
                      );
                    }
                  }
                },
              }
              : undefined;
            try {
              const result = definition.handler({
                ...this.context,
                request,
                execution: scoped,
                sessionDirectories: (ids, signal) => {
                  if (ids.length && definition.execution?.kind === "local") {
                    throw new Error(
                      "Local execution cannot resolve native identities",
                    );
                  }
                  const ready = this.#directories(
                    ids,
                    signal ?? scoped?.signal,
                  );
                  return scoped?.wait?.(ready) ?? ready;
                },
                sessionDirectory: async (id) => {
                  if (definition.execution?.kind === "local") {
                    throw new Error(
                      "Local execution cannot resolve native identities",
                    );
                  }
                  const ready = this.#directories([id], scoped?.signal);
                  return (await (scoped?.wait?.(ready) ?? ready))[id];
                },
              }, params);
              // Read ownership ends at the returned promise: synchronous work
              // above was observed, but waiting for the reader is not pressure.
              return await (scoped && definition.execution?.kind === "read"
                ? scoped.wait(Promise.resolve(result))
                : result);
            } finally {
              observe(false);
              finished = true;
            }
          },
        };
      },
    );
    if (definition.execution) this.#policies.set(method, definition.execution);
  }
  policy(method: string): RpcExecutionPolicy<never, unknown> | undefined {
    return this.#policies.get(method);
  }
  methods(): string[] {
    return [...this.#handlers.keys()];
  }
  prepare(method: string, value: unknown): PreparedRequest {
    const params = object(value);
    const prepare = this.#handlers.get(method);
    if (!prepare) throw new HarnessError("method", `Unknown method: ${method}`);
    return prepare(params);
  }
  async dispatch(
    method: string,
    value: unknown,
    request?: RequestLifetime,
    execution?: { signal: AbortSignal },
  ): Promise<unknown> {
    const prepared = this.prepare(method, value);
    return await prepared.run(
      execution
        ? {
          ...execution,
          key: {
            clientID: "standalone",
            key: crypto.randomUUID(),
            window: "standalone",
          },
          progress() {},
          beforeEffect: () => Promise.resolve(),
          checkpoint: () => Promise.resolve(),
          local: (run) => this.context.store.write(run),
        }
        : undefined,
      request,
    );
  }
}
