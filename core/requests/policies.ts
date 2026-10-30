// SPDX-License-Identifier: LGPL-3.0-only
import type { ReceiptData, RequestReceipts } from "@otk/protocol";
import type { RequestRecord, StoreWrite } from "@otk/store";
import type { RpcContext } from "../ws/registry.ts";
import type { RpcExecutionPolicy } from "./types.ts";
import type { OperationContext } from "@otk/protocol";

type Scope<P> = RpcExecutionPolicy<P, never>["scope"];

/** Read results are always reacquired from their owner, never persisted. */
export function readExecution<P, R>(scope: Scope<P>): RpcExecutionPolicy<P, R> {
  return {
    kind: "read",
    scope,
    receipt: () => undefined,
    recover: () => Promise.resolve({ state: "reload" }),
  };
}

export interface MetadataReceipt<R> {
  readonly kind: string;
  encode(result: R): ReceiptData;
  validate(receipt: ReceiptData): ReceiptData;
  restore(record: Readonly<RequestRecord>): R;
}

/** Features supply a runtime allowlist, including when rehydrating old receipts. */
export function metadataReceipt<K extends keyof RequestReceipts>(
  kind: K,
  parse: (value: unknown) => RequestReceipts[K],
): MetadataReceipt<RequestReceipts[K]> {
  return {
    kind,
    encode: (result) => ({ kind, value: parse(result) }) as ReceiptData,
    validate(receipt) {
      if (receipt.kind !== kind) throw new TypeError("Unexpected receipt kind");
      return { kind, value: parse(receipt.value) } as ReceiptData;
    },
    restore(record) {
      if (record.receipt_kind !== kind || record.receipt_json === null) {
        throw new Error("Missing metadata completion receipt");
      }
      return parse(JSON.parse(record.receipt_json));
    },
  };
}

/** A wire result may contain volatile content; only the feature's projection is durable. */
export function mappedReceipt<K extends keyof RequestReceipts, R>(
  kind: K,
  parse: (value: unknown) => RequestReceipts[K],
  encode: (result: R) => RequestReceipts[K],
  restore: (value: RequestReceipts[K]) => R,
): MetadataReceipt<R> {
  const metadata = metadataReceipt(kind, parse);
  return {
    kind,
    validate: metadata.validate,
    encode: (result) => metadata.encode(encode(result)),
    restore: (record) => restore(metadata.restore(record)),
  };
}

export function nativeExecution<P, R>(
  scope: Scope<P>,
  receipt: MetadataReceipt<R>,
): RpcExecutionPolicy<P, R> {
  return {
    kind: "native",
    scope,
    receipt: receipt.encode,
    checkpoint: receipt.validate,
    completion: receipt.validate,
    recover: (_ctx, record) =>
      Promise.resolve(
        record.receipt_kind === receipt.kind
          ? { state: "complete", result: receipt.restore(record) }
          : {
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          },
      ),
  };
}

/** The core fences independent backends too; adapters repeat the idempotent fence at I/O. */
export async function nativeEffect<R>(
  ctx: RpcContext,
  run: (operation?: OperationContext) => Promise<R>,
  receipt: MetadataReceipt<R>,
): Promise<R> {
  await ctx.execution?.beforeEffect();
  const result = await run(ctx.execution);
  await ctx.execution?.checkpoint(receipt.kind, receipt.encode(result));
  return result;
}

export function localExecution<P, R>(
  scope: Scope<P>,
  receipt: MetadataReceipt<R>,
): RpcExecutionPolicy<P, R> {
  return {
    kind: "local",
    scope,
    receipt: receipt.encode,
    completion: receipt.validate,
    recover: (_ctx, record) =>
      Promise.resolve({ state: "complete", result: receipt.restore(record) }),
  };
}

export function localResultExecution<P, T, R>(
  scope: Scope<P>,
  receipt: MetadataReceipt<T>,
  result: (value: T) => R,
): RpcExecutionPolicy<P, R> {
  return {
    kind: "local",
    scope,
    receipt: () => undefined,
    completion: receipt.validate,
    recover: (_ctx, record) =>
      Promise.resolve({
        state: "complete",
        result: result(receipt.restore(record)),
      }),
  };
}

/** Explicit scopes preserve independent in-process dispatch without nested writes. */
export function localWrite<R>(
  ctx: RpcContext,
  run: (tx: StoreWrite) => R,
  receipt: MetadataReceipt<R>,
): R {
  return ctx.execution
    ? ctx.execution.local(run, receipt.encode)
    : ctx.store.write(run);
}
