// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, Selection } from "@otk/client";
/** Navigation feature owns the command contracts; application owns the guards. */
export function registerSessionCommands(commands: CommandHub, actions: {
  available(input?: { sidecarId: string; directory: string }): boolean;
  create(input?: { sidecarId: string; directory: string }): Promise<void>;
  open(input: Selection): void;
  child(id: string): void;
  older(): Promise<void>;
  retry(): Promise<void>;
}): () => void {
  const releases = [
    commands.register({
      id: "session.new",
      title: "New session",
      category: "Session",
      slash: ["new"],
      enabled: (_ctx, input?: { sidecarId: string; directory: string }) =>
        actions.available(input),
      run: (_ctx, input?: { sidecarId: string; directory: string }) =>
        actions.create(input),
    }),
    commands.register({
      id: "session.open",
      title: "Open session",
      category: "Session",
      hidden: true,
      run: (_ctx, input: Selection) => actions.open(input),
    }),
    commands.register({
      id: "session.child",
      title: "Open subagent",
      category: "Session",
      hidden: true,
      run: (_ctx, id: string) => actions.child(id),
    }),
    commands.register({
      id: "session.older",
      title: "Load older messages",
      category: "Session",
      enabled: (context) => !!context.session,
      run: actions.older,
    }),
    commands.register({
      id: "session.retry",
      title: "Retry messages",
      category: "Session",
      enabled: (context) => !!context.session,
      run: actions.retry,
    }),
  ];
  return () => releases.forEach((release) => release());
}
