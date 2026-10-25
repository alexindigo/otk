// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, Selection, SessionRename } from "@otk/client";
import { countLabel } from "@otk/client";
import type { SessionContextTarget } from "../../features/session-context.ts";

/** Feature command contributions; target state and operations are injected. */
export function registerSessionActionCommands(commands: CommandHub, ports: {
  available(target: SessionContextTarget): boolean;
  rename: SessionRename;
  working(target: Selection): boolean;
  helpers(target: Selection): number;
  remove(target: Selection): Promise<boolean>;
}): () => void {
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
  };
}
