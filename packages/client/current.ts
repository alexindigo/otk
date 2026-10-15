// SPDX-License-Identifier: LGPL-3.0-only
import type { RpcMethod, RpcParams, RpcResult } from "@otk/protocol";
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
  call<M extends RpcMethod>(
    method: M,
    params: Omit<RpcParams<M>, "sessionID">,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>>;
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
    call<M extends RpcMethod>(
      method: M,
      params: Omit<RpcParams<M>, "sessionID">,
      signal?: AbortSignal,
    ): Promise<RpcResult<M>> {
      const { selection, rpc } = context();
      return rpc.call(
        method,
        { ...params, sessionID: selection.sessionID } as RpcParams<M>,
        signal,
      );
    },
  };
}
