// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, SessionRename } from "@otk/client";
import type { SessionContextTarget } from "../../features/session-context.ts";

/** Feature command contributions; target state and operations are injected. */
export function registerSessionActionCommands(commands: CommandHub, ports: {
  available(target: SessionContextTarget): boolean;
  rename: SessionRename;
}): () => void {
  return commands.register({
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
}
