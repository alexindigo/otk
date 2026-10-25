// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, Selection, SessionRename } from "@otk/client";
import { countLabel } from "@otk/client";
import type { SessionContextTarget } from "../../features/session-context.ts";
import type { ContentTarget } from "../../features/transcript-context.tsx";

/** Feature command contributions; target state and operations are injected. */
export function registerSessionActionCommands(commands: CommandHub, ports: {
  available(target: Selection): boolean;
  rename: SessionRename;
  working(target: Selection): boolean;
  helpers(target: Selection): number;
  remove(target: Selection): Promise<boolean>;
  current(): SessionContextTarget | undefined;
  fork(target: Selection & { title?: string }, through?: string): Promise<void>;
}): () => void {
  const fork = commands.register({
    id: "session.fork",
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
    hidden: true,
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
    hidden: true,
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
    hidden: true,
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
  };
}
