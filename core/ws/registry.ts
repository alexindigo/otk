// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { OtkDb } from "@otk/store";
import type { RpcMethod, RpcResult } from "@otk/protocol";
import { object } from "./params.ts";

/** Shared resources; features own their validation and operation handlers. */
export interface RpcContext {
  harness: Harness;
  store: OtkDb;
  request?: RequestLifetime;
  execution?: { signal: AbortSignal };
  sessionDirectory(sessionID: string): Promise<string>;
}
/** Socket-owned leases are distinct from a single read's execution signal. */
export interface RequestLifetime {
  id: string;
  signal: AbortSignal;
  defer(release: () => void): void;
}
export interface RpcDefinition<P, R> {
  params(value: Record<string, unknown>): P;
  handler(ctx: RpcContext, params: P): R | Promise<R>;
}
/** Dispatch has no knowledge of feature implementations or method names. */
export class RpcRegistry {
  #handlers = new Map<
    string,
    (ctx: RpcContext, p: Record<string, unknown>) => unknown
  >();
  readonly context: RpcContext;
  constructor(
    harness: Harness,
    store: OtkDb,
    readonly observe?: (owner: string, active: boolean) => void,
  ) {
    this.context = {
      harness,
      store,
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
      (ctx, p) => definition.handler(ctx, definition.params(p)),
    );
  }
  methods(): string[] {
    return [...this.#handlers.keys()];
  }
  async dispatch(
    method: string,
    value: unknown,
    request?: RequestLifetime,
    execution?: { signal: AbortSignal },
  ): Promise<unknown> {
    const params = object(value);
    const handler = this.#handlers.get(method);
    if (!handler) throw new HarnessError("method", `Unknown method: ${method}`);
    const owner = crypto.randomUUID();
    this.observe?.(owner, true);
    try {
      return await handler({ ...this.context, request, execution }, params);
    } finally {
      this.observe?.(owner, false);
    }
  }
}
