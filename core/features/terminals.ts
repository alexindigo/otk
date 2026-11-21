// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import { OperationFailure, type TerminalInfo } from "@otk/protocol";
import {
  TerminalHost,
  TerminalRejected,
  TerminalUnavailable,
} from "../terminals/host.ts";
import type { ProcessInfo } from "../terminals/frames.ts";
import { terminalOwner } from "../terminals/ownership.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { object, sessionID, text } from "../ws/params.ts";
import {
  mappedReceipt,
  metadataReceipt,
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";

export function terminalInfo(process: ProcessInfo): TerminalInfo {
  if (!process.pty) throw new Error("Expected PTY metadata");
  return {
    ...(terminalOwner(process.group_id)
      ? {
        checkout: terminalOwner(process.group_id)!.dir,
        ownerSessionID: terminalOwner(process.group_id)!.session,
      }
      : {}),
    id: String(process.id),
    title: process.pty.title,
    foreground: process.pty.foreground_process,
    cols: process.pty.cols,
    rows: process.pty.rows,
    status: process.lifecycle.status === "running" ? "running" : "exited",
    exitCode: process.lifecycle.status === "exited"
      ? process.lifecycle.exit_code
      : null,
    startedAt: process.started_at,
  };
}
function id(value: unknown): string {
  if (
    typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) throw new HarnessError("params", "Expected terminal ID");
  return value;
}
function dimension(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new HarnessError("params", "Expected terminal size in cells");
  }
  return Number(value);
}
function session(p: Record<string, unknown>): { sessionID: string } {
  const value = sessionID(p)!;
  if (value.length > 512) {
    throw new HarnessError("params", "Session ID too long");
  }
  return { sessionID: value };
}
async function available<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof TerminalUnavailable) {
      throw new OperationFailure("rejected", "terminal-unavailable", cause);
    }
    if (cause instanceof TerminalRejected) {
      throw new OperationFailure("rejected", cause.code, cause);
    }
    throw cause;
  }
}

export function registerTerminals(rpc: RpcRegistry, host?: TerminalHost): void {
  if (!host) return;
  const metadata = metadataReceipt("terminal-created", (value) => ({
    id: id(object(value).id),
  }));
  const created = mappedReceipt<"terminal-created", TerminalInfo>(
    "terminal-created",
    (value) => ({ id: id(object(value).id) }),
    (value) => ({ id: value.id }),
    () => {
      throw new Error("Terminal results must be reacquired from the daemon");
    },
  );
  const closed = completionReceipt("terminal-closed");
  rpc.register("terminal.list", {
    params: session,
    execution: readExecution((p: { sessionID: string }) => p),
    handler: (ctx, p) =>
      available(async () =>
        (await host.list(await ctx.sessionDirectory(p.sessionID))).map(
          terminalInfo,
        )
      ),
  });
  rpc.register("terminal.create", {
    params: (p) => ({
      ...session(p),
      cols: dimension(p.cols),
      rows: dimension(p.rows),
    }),
    execution: {
      ...nativeExecution(
        (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
        created,
      ),
      recover: async (_ctx, record) => {
        if (record.receipt_kind === metadata.kind) {
          const { id } = metadata.restore(record);
          const process = await host.owned(record.scope_session!, Number(id));
          if (process) {
            return { state: "complete", result: terminalInfo(process) };
          }
        }
        return {
          state: "pending",
          progress: { phase: "reconciling", code: "checking-outcome" },
        };
      },
    },
    async handler(ctx, p) {
      const cwd = await ctx.sessionDirectory(p.sessionID);
      const ready = available(() =>
        host.prepareCreate(p.sessionID, cwd, p.cols, p.rows)
      );
      const create = await (ctx.execution?.wait?.(ready) ?? ready);
      return nativeEffect(
        ctx,
        () => available(async () => terminalInfo(await create())),
        created,
      );
    },
  });
  rpc.register("terminal.close", {
    params: (p) => ({ ...session(p), terminalID: id(text(p, "terminalID")) }),
    execution: nativeExecution(
      (p: { sessionID: string; terminalID: string }) => ({
        sessionID: p.sessionID,
        resource: p.terminalID,
      }),
      closed,
    ),
    async handler(ctx, p) {
      const directory = await ctx.sessionDirectory(p.sessionID);
      const ready = available(() => host.list(directory));
      const processes = await (ctx.execution?.wait?.(ready) ?? ready);
      if (!processes.some((process) => String(process.id) === p.terminalID)) {
        throw new OperationFailure(
          "rejected",
          "not-found",
          new Error("Terminal not found"),
        );
      }
      return nativeEffect(ctx, async () => {
        await available(() => host.close(directory, Number(p.terminalID)));
        return null;
      }, closed);
    },
  });
}
