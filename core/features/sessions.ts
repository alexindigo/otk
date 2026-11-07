// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { MAX_MESSAGE_CURSOR_LENGTH } from "@otk/protocol";
import {
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { createdReceipt } from "./session-receipts.ts";
import type { ContentSession } from "@otk/protocol";
import type { StoreWrite } from "@otk/store";
import type { RpcContext } from "../ws/registry.ts";

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  created?: (directory: string, tx?: StoreWrite) => void,
): void {
  const finish = (ctx: RpcContext, value: ContentSession): ContentSession =>
    ctx.execution
      ? ctx.execution.local((tx) => {
        created?.(value.directory, tx);
        return value;
      }, createdReceipt.encode)
      : (created?.(value.directory), value);
  rpc.register("session.get", {
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: (ctx, id) =>
      ctx.harness.core.getSession(id, ctx.execution?.signal),
  });
  rpc.register("session.children", {
    execution: readExecution((id: string) => ({ sessionID: id })),
    params: (p) => sessionID(p)!,
    handler: (ctx, id) =>
      ctx.harness.core.listChildren(id, ctx.execution?.signal),
  });
  rpc.register("session.messages", {
    execution: readExecution((p: { sessionID: string }) => ({
      sessionID: p.sessionID,
    })),
    params(p) {
      if (
        Object.keys(p).some((key) => key !== "sessionID" && key !== "before")
      ) throw new HarnessError("params", "Unknown message page parameter");
      const before = text(p, "before", true);
      if (
        before !== undefined &&
        (!before.length || before.length > MAX_MESSAGE_CURSOR_LENGTH)
      ) throw new HarnessError("params", "Invalid message cursor length");
      return {
        sessionID: sessionID(p)!,
        before,
      };
    },
    async handler(ctx, p) {
      const settle = p.before === undefined
        ? ctx.request?.firstPage?.(p.sessionID)
        : undefined;
      const signal = ctx.execution?.signal;
      if (settle) signal?.addEventListener("abort", settle, { once: true });
      try {
        signal?.throwIfAborted();
        return await ctx.harness.core.listMessages(p.sessionID, {
          before: p.before,
        }, signal);
      } catch (error) {
        settle?.();
        throw error;
      } finally {
        if (settle) signal?.removeEventListener("abort", settle);
      }
    },
  });
  rpc.register("session.create", {
    execution: {
      ...nativeExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        createdReceipt,
      ),
      recover: (ctx, record, execution) => {
        if (record.receipt_kind !== createdReceipt.kind) {
          return Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          });
        }
        const value = createdReceipt.restore(record);
        return Promise.resolve({
          state: "complete",
          result: record.state === "succeeded"
            ? value
            : finish({ ...ctx, execution }, value),
        });
      },
    },
    params: (p) => ({
      directory: text(p, "directory")!,
      title: text(p, "title", true),
      parentID: sessionID(p, "parentID", true),
    }),
    async handler(ctx, p) {
      const session = await nativeEffect(
        ctx,
        (operation) => ctx.harness.core.createSession(p, operation),
        createdReceipt,
      );
      return finish(ctx, session);
    },
  });
}
