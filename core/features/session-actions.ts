// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import { Requests, type StoreWrite } from "@otk/store";
import type { ContentSession } from "@otk/protocol";
import { MAX_SESSION_TITLE } from "@otk/protocol";
import type { RpcContext } from "../ws/registry.ts";
import { nativeEffect, nativeExecution } from "../requests/policies.ts";
import {
  archivedReceipt,
  completionReceipt,
  createdReceipt,
  renamedReceipt,
  renameIntent,
  selectionReceipt,
} from "./session-receipts.ts";

export function register(
  rpc: RpcRegistry,
  harness: Harness,
  created?: (directory: string, tx?: StoreWrite) => void,
): void {
  const archive = harness.capabilities.sessionArchive;
  if (archive) {
    rpc.register("session.archive", {
      execution: nativeExecution(
        (p: { sessionID: string }) => ({
          sessionID: p.sessionID,
          resource: "archive",
        }),
        archivedReceipt,
      ),
      params(p) {
        if (typeof p.archived !== "boolean") {
          throw new HarnessError("params", "archived must be a boolean");
        }
        return { sessionID: sessionID(p)!, archived: p.archived };
      },
      handler: (ctx, p) =>
        nativeEffect(
          ctx,
          (operation) => archive.archive(p.sessionID, p.archived, operation),
          archivedReceipt,
        ),
    });
  }
  const actions = harness.capabilities.sessionActions;
  if (!actions) return;
  const compacted = completionReceipt("session-compacted"),
    deleted = completionReceipt("session-deleted");
  const finish = (ctx: RpcContext, value: ContentSession): ContentSession =>
    ctx.execution
      ? ctx.execution.local((tx) => {
        created?.(value.directory, tx);
        return value;
      }, createdReceipt.encode)
      : (created?.(value.directory), value);
  rpc.register("session.compact", {
    execution: {
      ...nativeExecution(
        (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
        compacted,
      ),
      checkpoint: (receipt) =>
        receipt.kind === selectionReceipt.kind
          ? selectionReceipt.validate(receipt)
          : compacted.validate(receipt),
    },
    params(p) {
      const model = object(p.model);
      return {
        sessionID: sessionID(p)!,
        model: {
          provider: text(model, "provider")!,
          model: text(model, "model")!,
        },
      };
    },
    handler: (ctx, p) =>
      nativeEffect(ctx, async (operation) => {
        await actions.compact(p.sessionID, p.model, operation);
        return null;
      }, compacted),
  });
  rpc.register("session.fork", {
    execution: {
      ...nativeExecution(
        (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
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
      sessionID: sessionID(p)!,
      through: p.through === undefined ? undefined : text(p, "through"),
    }),
    async handler(ctx, p) {
      const session = await nativeEffect(
        ctx,
        (operation) => actions.fork(p.sessionID, p.through, operation),
        createdReceipt,
      );
      return finish(ctx, session);
    },
  });
  rpc.register("session.delete", {
    execution: {
      ...nativeExecution(
        (id: string) => ({ sessionID: id, resource: "lifetime" }),
        deleted,
      ),
      recover: (_ctx, record) =>
        Promise.resolve(
          record.receipt_kind === deleted.kind ||
            _ctx.sessionMetadata?.(record.scope_session!)?.deleted
            ? { state: "complete", result: null }
            : {
              state: "pending",
              progress: { phase: "reconciling", code: "checking-outcome" },
            },
        ),
    },
    params: (p) => sessionID(p)!,
    handler: (ctx, id) =>
      nativeEffect(ctx, async (operation) => {
        await actions.remove(id, operation);
        return null;
      }, deleted),
  });
  rpc.register("session.rename", {
    execution: {
      ...nativeExecution(
        (p: { sessionID: string }) => ({
          sessionID: p.sessionID,
          resource: "title",
        }),
        renamedReceipt,
      ),
      checkpoint: (receipt) =>
        receipt.kind === renameIntent.kind
          ? renameIntent.validate(receipt)
          : renamedReceipt.validate(receipt),
      recover: async (ctx, record, execution) => {
        if (record.receipt_kind === renamedReceipt.kind) {
          return { state: "complete", result: renamedReceipt.restore(record) };
        }
        if (
          record.receipt_kind === renameIntent.kind &&
          !new Requests(ctx.store).superseded(record)
        ) {
          const expected = renameIntent.restore(record);
          const current = await ctx.harness.core.getSession(
            expected.sessionID,
            execution.signal,
          );
          if (current.title === expected.title) {
            return { state: "complete", result: current };
          }
        }
        return {
          state: "pending",
          progress: { phase: "reconciling", code: "checking-outcome" },
        };
      },
    },
    params(p) {
      const id = sessionID(p)!;
      const title = text(p, "title")!.trim();
      if (!title || title.length > MAX_SESSION_TITLE) {
        throw new HarnessError(
          "session.title",
          `title must be 1..${MAX_SESSION_TITLE} characters`,
        );
      }
      return { sessionID: id, title };
    },
    handler: async (ctx, p) => {
      await ctx.execution?.checkpoint(
        renameIntent.kind,
        renameIntent.encode(p),
      );
      return await nativeEffect(
        ctx,
        (operation) => actions.rename(p.sessionID, p.title, operation),
        renamedReceipt,
      );
    },
  });
}
