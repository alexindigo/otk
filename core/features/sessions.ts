// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import {
  isSessionID,
  type LoadCoverage,
  MAX_MESSAGE_CURSOR_LENGTH,
  MAX_SESSION_LIST_SIZE,
  MESSAGE_PAGE_SIZE,
  SESSION_LIST_SIZE,
  type SessionListInput,
  sessionListKey,
  type SessionListPage,
} from "@otk/protocol";
import { projectPath } from "./project-scan.ts";
import {
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { createdReceipt } from "./session-receipts.ts";
import type { ContentSession } from "@otk/protocol";
import type { StoreWrite } from "@otk/store";
import type { RpcContext } from "../ws/registry.ts";
import type { SessionHierarchy } from "../index/session-hierarchy.ts";

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  created?: (directory: string, tx?: StoreWrite) => void,
  publishrows = SESSION_LIST_SIZE,
  hierarchy?: SessionHierarchy,
): void {
  const generation = crypto.randomUUID();
  const begin = (
    ctx: RpcContext,
    scope: LoadCoverage["scope"],
    boundary: LoadCoverage["boundary"],
    data: import("@otk/protocol").LoadChunk["data"],
  ): LoadCoverage => {
    const load: LoadCoverage = {
      id: ctx.execution?.key.key ?? crypto.randomUUID(),
      scope,
      boundary,
      generation: scope.kind === "session-messages" ? "pending" : generation,
      revision: 0,
      state: "loading",
    };
    (ctx.execution?.signal ?? ctx.request?.signal)?.throwIfAborted();
    if (ctx.execution?.key) {
      ctx.request?.publish?.({
        t: "load.chunk",
        request: ctx.execution.key,
        epoch: ctx.request.view?.().epoch ?? 0,
        load,
        data,
      });
    }
    return load;
  };
  const lists = new Map<string, SessionListPage>();
  const parseList = (p: Record<string, unknown>): SessionListInput => {
    if (
      Object.keys(p).some((key) =>
        !["directory", "parentID", "query", "before", "limit"].includes(key)
      )
    ) {
      throw new HarnessError("params", "Unknown session list parameter");
    }
    const limit = p.limit ?? SESSION_LIST_SIZE;
    if (
      !Number.isSafeInteger(limit) || Number(limit) < 1 ||
      Number(limit) > MAX_SESSION_LIST_SIZE
    ) {
      throw new HarnessError("params", "Invalid session list size");
    }
    const before = text(p, "before", true);
    if (
      before !== undefined &&
      (!before.length || before.length > MAX_MESSAGE_CURSOR_LENGTH)
    ) {
      throw new HarnessError("params", "Invalid session list cursor");
    }
    return {
      directory: projectPath(text(p, "directory")!),
      parentID: p.parentID === null ? null : sessionID(p, "parentID", true),
      query: text(p, "query", true),
      before,
      limit: Number(limit),
    };
  };
  rpc.register("sessions.identities", {
    execution: readExecution(() => ({ resource: "session-identities" })),
    params(p) {
      if (
        !Array.isArray(p.ids) || p.ids.length > MAX_SESSION_LIST_SIZE ||
        !p.ids.every(isSessionID)
      ) {
        throw new HarnessError(
          "params",
          "Expected bounded qualified session identities",
        );
      }
      return [...new Set(p.ids)] as string[];
    },
    handler: async (ctx, ids) => {
      const rows = await ctx.harness.core.identities(
        ids,
        ctx.execution?.signal,
      );
      if (!hierarchy) return rows;
      await hierarchy.prepare(
        rows,
        (keys, signal) => ctx.harness.core.identities(keys, signal),
        ctx.execution?.signal,
      );
      return rows.map((row) => ({
        ...row,
        hierarchy: hierarchy.node(
          row.id,
          ctx.request?.view?.().tasksFollowParent,
        ),
      }));
    },
  });
  const serveList = async (
    ctx: RpcContext,
    input: SessionListInput,
  ): Promise<SessionListPage> => {
    const signal = ctx.execution?.signal ?? ctx.request?.signal ??
      new AbortController().signal;
    const key = sessionListKey(input), cached = lists.get(key);
    const epoch = ctx.request?.view?.().epoch ?? 0;
    const identity = ctx.execution?.key;
    const load: LoadCoverage = {
      id: identity?.key ?? crypto.randomUUID(),
      scope: typeof input.parentID === "string"
        ? {
          kind: "parent-children",
          directory: input.directory,
          parentID: input.parentID,
        }
        : {
          kind: "project-sessions",
          directory: input.directory,
          query: input.query,
          ...(input.parentID === null ? { parentID: null } : {}),
        },
      boundary: { kind: "page", before: input.before, limit: input.limit! },
      generation: cached?.load.generation ?? "pending",
      revision: 0,
      state: "loading",
    };
    signal.throwIfAborted();
    let revision = 0;
    const items = cached?.items.map((item) =>
      hierarchy
        ? {
          ...item,
          hierarchy: hierarchy.node(
            item.id,
            ctx.request?.view?.().tasksFollowParent,
          ),
        }
        : item
    ) ?? [];
    if (identity) {
      for (
        let offset = 0;
        offset < items.length || offset === 0;
        offset += publishrows
      ) {
        signal.throwIfAborted();
        ctx.request?.publish?.({
          t: "load.chunk",
          request: identity,
          epoch,
          load: { ...load, revision: revision++ },
          data: {
            kind: "session-list",
            items: items.slice(offset, offset + publishrows),
            older: cached?.older ?? null,
            offset,
          },
        });
      }
    }
    const value = await ctx.harness.core.listSessions(input, signal);
    await hierarchy?.prepare(
      value.items,
      (ids, signal) => ctx.harness.core.identities(ids, signal),
      signal,
    );
    signal.throwIfAborted();
    const result: SessionListPage = {
      items: value.items.map(({ id, directory, parentID, title }) => ({
        id,
        directory,
        parentID,
        title,
        ...(hierarchy
          ? {
            hierarchy: hierarchy.node(
              id,
              ctx.request?.view?.().tasksFollowParent,
            ),
          }
          : {}),
      })),
      older: value.older,
      load: {
        ...load,
        generation: value.generation,
        revision: revision + 1,
        state: "complete",
      },
    };
    lists.set(key, result);
    return result;
  };
  rpc.register("sessions.list", {
    execution: readExecution((p: SessionListInput) => ({
      directory: p.directory,
    })),
    params: parseList,
    handler: serveList,
  });
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
    handler: async (ctx, id) => {
      const load = begin(ctx, { kind: "session-metadata", sessionID: id }, {
        kind: "metadata",
      }, { kind: "session-metadata", session: null });
      const session = await ctx.harness.core.getSession(
        id,
        ctx.execution?.signal,
      );
      await hierarchy?.prepare(
        [session],
        (ids, signal) => ctx.harness.core.identities(ids, signal),
        ctx.execution?.signal,
      );
      ctx.execution?.signal.throwIfAborted();
      return {
        ...session,
        ...(hierarchy
          ? {
            hierarchy: hierarchy.node(
              id,
              ctx.request?.view?.().tasksFollowParent,
            ),
          }
          : {}),
        load: { ...load, revision: 1, state: "complete" as const },
      };
    },
  });
  rpc.register("session.children", {
    execution: readExecution((p: { sessionID: string }) => ({
      sessionID: p.sessionID,
    })),
    params: (p) => ({
      sessionID: sessionID(p)!,
      before: text(p, "before", true),
    }),
    handler: async (ctx, p) =>
      serveList(
        ctx,
        parseList({
          directory: await ctx.sessionDirectory(p.sessionID),
          parentID: p.sessionID,
          before: p.before,
        }),
      ),
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
    cancelled: (p, request) =>
      p.before === undefined ? request?.firstPage?.(p.sessionID) : undefined,
    async handler(ctx, p) {
      const settle = p.before === undefined
        ? ctx.request?.firstPage?.(p.sessionID)
        : undefined;
      const signal = ctx.execution?.signal;
      const epoch = ctx.request?.view?.().epoch ?? 0;
      if (settle) signal?.addEventListener("abort", settle, { once: true });
      try {
        signal?.throwIfAborted();
        const load = begin(
          ctx,
          { kind: "session-messages", sessionID: p.sessionID },
          { kind: "page", before: p.before, limit: MESSAGE_PAGE_SIZE },
          { kind: "message-page", page: null },
        );
        const page = await ctx.harness.core.listMessages(p.sessionID, {
          before: p.before,
          publish(page) {
            signal?.throwIfAborted();
            if (!ctx.execution?.key) return;
            ctx.request?.publish?.({
              t: "load.chunk",
              request: ctx.execution.key,
              epoch,
              load: {
                ...load,
                revision: 1,
                generation:
                  `${page.version.generation}:${page.version.revision}:${page.clock.epoch}`,
              },
              data: { kind: "message-page", page },
            });
          },
        }, signal);
        signal?.throwIfAborted();
        return {
          ...page,
          load: {
            ...load,
            generation:
              `${page.version.generation}:${page.version.revision}:${page.clock.epoch}`,
            revision: 2,
            state: "complete" as const,
          },
        };
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
