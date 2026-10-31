// SPDX-License-Identifier: LGPL-3.0-only
import type {
  OperationContext,
  ReceiptData,
  RequestProgress,
} from "@otk/protocol";
import type { RequestRecord, StoreWrite } from "@otk/store";
import type { RpcContext } from "../ws/registry.ts";

export interface RequestExecution extends OperationContext {
  local<T>(run: (tx: StoreWrite) => T, receipt: (result: T) => ReceiptData): T;
}
export type RequestRecovery<R> =
  | { state: "complete"; result: R }
  | { state: "pending"; progress: RequestProgress }
  | { state: "reload" };
export interface RpcExecutionPolicy<P, R> {
  priority?: "ordinary" | "interrupt";
  kind: "read" | "local" | "native" | "lease";
  /** A settled watch can retain an explicitly releasable operation lifetime. */
  lifetime?: "request";
  scope(
    params: P,
  ): { sessionID?: string; directory?: string; resource?: string };
  receipt(result: R): ReceiptData | undefined;
  /** Explicit runtime encoder for safe intermediate witnesses. */
  checkpoint?(receipt: ReceiptData): ReceiptData;
  /** Completion validation is independent of the handler's internal write result. */
  completion?(receipt: ReceiptData): ReceiptData;
  recover(
    ctx: RpcContext,
    record: Readonly<RequestRecord>,
    execution: RequestExecution,
  ): Promise<RequestRecovery<R>>;
}
export interface PreparedRequest {
  readonly execution?: RpcExecutionPolicy<never, unknown>;
  readonly scope: { sessionID?: string; directory?: string; resource?: string };
  run(
    execution?: RequestExecution,
    request?: RpcContext["request"],
  ): Promise<unknown>;
}
