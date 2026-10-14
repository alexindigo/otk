// SPDX-License-Identifier: LGPL-3.0-only
import type { RpcMethod } from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
import type { Rpc } from "./rpc.ts";
import type { Selection } from "./session.ts";

export interface CurrentContext {
  selection: Selection;
  connection: SidecarConnection;
  rpc: Rpc;
}
export interface CurrentClient {
  context(): CurrentContext;
  call<T>(
    method: RpcMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}
/** Resolve selection at invocation time, never retaining a stale connection. */
export function createCurrentClient(
  selected: () => Selection | undefined,
  connection: (id: string) => SidecarConnection,
): CurrentClient {
  const context = (): CurrentContext => {
    const selection = selected();
    if (!selection) throw new Error("No session selected");
    const current = connection(selection.sidecarId);
    return { selection, connection: current, rpc: current.rpc };
  };
  return {
    context,
    call<T>(
      method: RpcMethod,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> {
      const { selection, rpc } = context();
      return rpc.call<T>(
        method,
        { ...params, sessionID: selection.sessionID },
        signal,
      );
    },
  };
}
