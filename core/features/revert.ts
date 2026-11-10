// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { Requests } from "@otk/store";
import { nativeEffect } from "../requests/policies.ts";
import { boundaryIntent, boundaryReceipt } from "./session-receipts.ts";
import type { ContentSession, RequestReceipts } from "@otk/protocol";
import type { RpcExecutionPolicy } from "../requests/types.ts";

type Mode = RequestReceipts["session-boundary"]["mode"];
function execution<P extends { sessionID: string }>(
  mode?: Mode,
): RpcExecutionPolicy<
  P,
  ContentSession
> {
  return {
    kind: "native",
    scope: (p) => ({ sessionID: p.sessionID, resource: "boundary" }),
    receipt: (session) =>
      boundaryReceipt.encode({
        sessionID: session.id,
        messageID: session.revert?.messageID ?? null,
        ...(mode ? { mode } : {}),
      }),
    checkpoint: (receipt) =>
      receipt.kind === boundaryIntent.kind
        ? boundaryIntent.validate(receipt)
        : boundaryReceipt.validate(receipt),
    recover: async (ctx, record, operation) => {
      const complete = record.receipt_kind === boundaryReceipt.kind;
      if (
        complete ||
        record.receipt_kind === boundaryIntent.kind &&
          !new Requests(ctx.store).superseded(record)
      ) {
        const expected = (complete ? boundaryReceipt : boundaryIntent).restore(
          record,
        );
        const current = await ctx.harness.core.getSession(
          expected.sessionID,
          operation.signal,
        );
        if (
          !complete && expected.mode === "restore" &&
          expected.after !== undefined &&
          !current.revert && ctx.harness.capabilities.restore?.settle
        ) {
          return {
            state: "complete",
            result: await ctx.harness.capabilities.restore.settle(
              expected.sessionID,
              expected.after,
              operation,
            ),
          };
        }
        if (
          complete ||
          !mode && !expected.mode &&
            (current.revert?.messageID ?? null) === expected.messageID
        ) return { state: "complete", result: current };
      }
      return {
        state: "pending",
        progress: { phase: "reconciling", code: "checking-outcome" },
      };
    },
  };
}
const receipt = (mode?: Mode) => ({
  kind: boundaryReceipt.kind,
  validate: boundaryReceipt.validate,
  encode: (session: ContentSession) =>
    boundaryReceipt.encode({
      sessionID: session.id,
      messageID: session.revert?.messageID ?? null,
      ...(mode ? { mode } : {}),
    }),
  restore: () => {
    throw new Error("Boundary results use their authoritative reader");
  },
});

export function register(rpc: RpcRegistry, harness: Harness): void {
  for (
    const [method, capability, mode] of [
      [
        "session.revert",
        harness.capabilities.revert,
        harness.capabilities.revertCode ? "messages" : undefined,
      ],
      ["session.revertCode", harness.capabilities.revertCode, "code"],
    ] as const
  ) {
    if (!capability) continue;
    rpc.register(method, {
      execution: execution(mode),
      params: (p) => ({
        sessionID: sessionID(p)!,
        messageID: text(p, "messageID")!,
      }),
      handler: async (ctx, p) => {
        await ctx.execution?.checkpoint(
          boundaryIntent.kind,
          boundaryIntent.encode({ ...p, ...(mode ? { mode } : {}) }),
        );
        return await nativeEffect(
          ctx,
          (operation) => capability.revert(p.sessionID, p.messageID, operation),
          receipt(mode),
        );
      },
    });
  }
  const restore = harness.capabilities.restore;
  if (restore) {
    const mode = harness.capabilities.revertCode ? "restore" : undefined;
    rpc.register("session.restore", {
      execution: execution(mode),
      params: (p) => ({ sessionID: sessionID(p)! }),
      handler: async (ctx, p) => {
        await ctx.execution?.checkpoint(
          boundaryIntent.kind,
          boundaryIntent.encode({
            sessionID: p.sessionID,
            messageID: null,
            ...(mode ? { mode } : {}),
          }),
        );
        return await nativeEffect(
          ctx,
          (operation) => restore.restore(p.sessionID, operation),
          receipt(mode),
        );
      },
    });
  }
}
