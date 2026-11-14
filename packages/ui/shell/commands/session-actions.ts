// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CommandHub,
  Selection,
  SessionRename,
  SessionRevert,
} from "@otk/client";
import { countLabel } from "@otk/client";
import type { SessionContextTarget } from "../../features/session-context.ts";
import type { ContentTarget } from "../../features/transcript-context.tsx";

/** Feature command contributions; target state and operations are injected. */
export function registerSessionActionCommands(commands: CommandHub, ports: {
  available(target: Selection): boolean;
  archiveAvailable?(target: Selection): boolean;
  archived?(target: Selection): boolean | undefined;
  archive?(target: Selection, archived: boolean): Promise<unknown>;
  rename: SessionRename;
  working(target: Selection): boolean;
  helpers(target: Selection): number;
  remove(target: Selection): Promise<boolean>;
  current(): SessionContextTarget | undefined;
  fork(target: Selection & { title?: string }, through?: string): Promise<void>;
  revert?: SessionRevert;
  revertAvailable?(
    target: Selection,
    capability: "revert" | "revertCode" | "restore",
    interrupt?: boolean,
  ): boolean;
  rolledBack?(): boolean;
}): () => void {
  const rollback = commands.register({
    id: "prompt.revert",
    title: "Revert to here",
    category: "Transcript",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
        messageID: { type: "string" },
      },
    },
    context: { kind: "prompt", order: 5 },
    enabled: (_ctx, target?: ContentTarget) =>
      !!target?.sidecarId && !!target.sessionID && !!target.messageID &&
      !target.queued &&
      !!ports.revert?.matches({
        sidecarId: target.sidecarId,
        sessionID: target.sessionID,
      }) &&
      !!ports.revertAvailable?.({
        sidecarId: target.sidecarId,
        sessionID: target.sessionID,
      }, "revert"),
    run: (_ctx, target: ContentTarget) =>
      ports.revert!.revertTo(target.messageID!),
  });
  const canRestore = (input?: SessionContextTarget) => {
    const target = input ?? ports.current();
    return !!target && !!ports.revert?.matches(target) &&
      !!ports.rolledBack?.() && !!ports.revertAvailable?.(target, "restore");
  };
  const code = commands.register({
    id: "prompt.revertCode",
    title: "Revert code changes",
    category: "Transcript",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
        messageID: { type: "string" },
      },
    },
    context: { kind: "prompt", order: 6 },
    enabled: (_ctx, target?: ContentTarget) =>
      !!target?.sidecarId && !!target.sessionID && !!target.messageID &&
      !target.queued &&
      !!ports.revert?.matches({
        sidecarId: target.sidecarId,
        sessionID: target.sessionID,
      }) &&
      !!ports.revertAvailable?.({
        sidecarId: target.sidecarId,
        sessionID: target.sessionID,
      }, "revertCode"),
    run: (_ctx, target: ContentTarget) =>
      ports.revert!.revertTo(target.messageID!, true),
  });
  const archive = [true, false].map((archived) =>
    commands.register({
      id: archived ? "session.archive" : "session.unarchive",
      title: archived ? "Archive" : "Unarchive",
      category: "Session",
      arguments: {
        type: "object",
        properties: {
          sidecarId: { type: "string" },
          sessionID: { type: "string" },
        },
      },
      context: { kind: "session", order: 35 },
      enabled: (_ctx, target?: SessionContextTarget) => {
        if (
          !target || !ports.archive || !ports.archiveAvailable?.(target)
        ) return false;
        const current = ports.archived?.(target);
        return current !== undefined && current !== archived;
      },
      run: (_ctx, target: SessionContextTarget) =>
        ports.archive!(target, archived),
    })
  );
  const undo = commands.register({
    id: "session.undo",
    title: "Undo previous prompt",
    category: "Session",
    name: "undo",
    enabled: () => {
      const target = ports.current();
      return !!target && !!ports.revert?.hasPrompt() &&
        !!ports.revertAvailable?.(target, "revert", true);
    },
    run: () => ports.revert!.undo(),
  });
  const redo = commands.register({
    id: "session.redo",
    title: "Redo",
    category: "Session",
    name: "redo",
    arguments: { type: "object", optional: true },
    enabled: (_ctx, input?: SessionContextTarget) => canRestore(input),
    run: () => ports.revert!.redo(),
  });
  const restore = commands.register({
    id: "session.restore",
    title: "Restore conversation",
    name: "restore",
    description:
      "Bring back rolled-back messages and the unchanged pre-revert draft",
    category: "Session",
    arguments: { type: "object", optional: true },
    context: { kind: "session", order: 25 },
    enabled: (_ctx, input?: SessionContextTarget) => canRestore(input),
    run: () => ports.revert!.restore(),
  });
  const fork = commands.register({
    id: "session.fork",
    arguments: { type: "object", optional: true },
    title: "Fork session",
    category: "Session",
    context: { kind: "session", order: 30 },
    enabled: (_ctx, input?: SessionContextTarget) => {
      const target = input ?? ports.current();
      return !!target && ports.available(target);
    },
    run: (_ctx, input?: SessionContextTarget) =>
      ports.fork((input ?? ports.current())!),
  });
  const reply = commands.register({
    id: "reply.fork",
    title: "Fork from here",
    category: "Transcript",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
        lastID: { type: "string" },
      },
    },
    context: { kind: "reply", order: 5 },
    enabled: (_ctx, target?: ContentTarget) =>
      !!target?.sidecarId && !!target.sessionID && !!target.lastID &&
      !!target.completed &&
      ports.available({
        sidecarId: target.sidecarId,
        sessionID: target.sessionID,
      }),
    run: (_ctx, target: ContentTarget) =>
      ports.fork(
        { sidecarId: target.sidecarId!, sessionID: target.sessionID! },
        target.lastID,
      ),
  });
  const rename = commands.register({
    id: "session.rename",
    title: "Rename",
    category: "Session",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
      },
    },
    context: { kind: "session", order: 20 },
    enabled: (_ctx, target?: SessionContextTarget) =>
      !!target && ports.available(target),
    run: (_ctx, target: SessionContextTarget) =>
      ports.rename.start(target, target.origin ?? "chip"),
  });
  const remove = commands.register({
    id: "session.delete",
    title: "Delete",
    category: "Session",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
      },
    },
    context: {
      kind: "session",
      destructive: true,
      confirm: (target: SessionContextTarget) => {
        const helpers = ports.helpers(target);
        return `Press again to ${
          ports.working(target) ? "stop and delete" : "delete"
        }${helpers ? `, including ${countLabel(helpers, "helper")}` : ""}`;
      },
    },
    enabled: (_ctx, target?: SessionContextTarget) =>
      !!target && ports.available(target),
    run: (_ctx, target: SessionContextTarget) => ports.remove(target),
  });
  return () => {
    rename();
    remove();
    fork();
    reply();
    rollback();
    code();
    archive.forEach((release) => release());
    restore();
    undo();
    redo();
  };
}
