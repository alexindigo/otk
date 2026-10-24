// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, Selection } from "@otk/client";
/** Navigation feature owns the command contracts; the consumer owns the guards. */
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
      context: {
        kind: ["app", "panel", "project"],
        order: -10,
        items: (
          input?: {
            sidecarId: string;
            directory: string;
            discovered?: boolean;
          },
        ) =>
          input?.discovered === false
            ? []
            : [{ key: "new", title: "New session", args: input }],
      },
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

/** Context choices describe state transitions; ordinary control re-selection
 * remains available through the same command owners. */
export function registerSessionTargetCommands(commands: CommandHub, actions: {
  current(): Selection | undefined;
  exists(target: Selection): boolean;
  connected(target: Selection): boolean;
  inTask(target: Selection): boolean;
  open(target: Selection): boolean;
  pin(target: Selection): Promise<boolean>;
}): () => void {
  const shown = (target: Selection) => {
    const current = actions.current();
    return current?.sidecarId === target.sidecarId &&
      current?.sessionID === target.sessionID;
  };
  const releases = [
    commands.register({
      id: "session.preview",
      title: "Preview session",
      category: "Session",
      hidden: true,
      context: {
        kind: "session",
        items: (target?: Selection) =>
          !target || shown(target)
            ? []
            : [{ key: "open", title: "Open", args: target }],
        order: 0,
      },
      enabled: (_ctx, target?: Selection) => !!target && actions.exists(target),
      run: (_ctx, target: Selection) => actions.open(target),
    }),
    commands.register({
      id: "session.pin",
      title: "Open session as task",
      category: "Session",
      hidden: true,
      context: {
        kind: "session",
        items: (target?: Selection) => {
          if (!target) return [];
          const inTask = actions.inTask(target);
          return inTask && shown(target) ? [] : [{
            key: "task",
            title: inTask ? "Open as task" : "Pin as task",
            args: target,
          }];
        },
        order: 10,
      },
      enabled: (_ctx, target?: Selection) =>
        !!target && actions.exists(target) && actions.connected(target),
      run: (_ctx, target: Selection) => actions.pin(target),
    }),
  ];
  return () => releases.forEach((release) => release());
}
