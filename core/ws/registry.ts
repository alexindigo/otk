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
}
/** Socket-owned leases are distinct from a single read's execution signal. */
export interface RequestLifetime {
  id: string;
  signal: AbortSignal;
  defer(release: () => void): void;
}
export interface RpcDefinition<P, R> {
  // Validation owns P. Policy factories consume it without widening handlers.
  execution?: RpcExecutionPolicy<NoInfer<P>, R>;
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
      sessionDirectory: async (id) =>
        (await harness.core.getSession(id)).directory,
    };
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
          run: async (execution, request) => {
            const owner = crypto.randomUUID();
            let finished = false, active = false;
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
                  observe(false);
                  try {
                    return await ready;
                  } finally {
                    observe(true);
                  }
                },
              }
              : undefined;
            try {
              const result = definition.handler({
                ...this.context,
                request,
                execution: scoped,
                sessionDirectory: async (id) => {
                  const ready = this.context.harness.core.getSession(
                    id,
                    scoped?.signal,
                  );
                  return (await (scoped?.wait?.(ready) ?? ready)).directory;
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
