// SPDX-License-Identifier: LGPL-3.0-only
import { type Selection, sessionKey } from "@otk/client";
import type { ShellLayout } from "@otk/protocol";
import { type CommandPorts, ownedCommand } from "../keyboard/context.tsx";
import type { PanelDefinition, SurfaceRegistry } from "../registries/shell.ts";
import type { ShellWork } from "../state/shell.ts";

type ShowTarget = Selection & { turn: string; run?: string };
const scopeOf = ({ sidecarId, sessionID }: Selection) =>
  sessionKey(sidecarId, sessionID);

export function registerWorkCommands(ports: CommandPorts, input: {
  work: ShellWork;
  panels: SurfaceRegistry<PanelDefinition>;
  selection(): Selection | undefined;
  ready(): boolean;
  lastMessageID(turn: string): string | undefined;
  layout(): ShellLayout;
  saveLayout(value: Partial<ShellLayout>): Promise<unknown>;
  panelPresentation?(): "inline" | "sheet";
}): void {
  const { panel, model } = input.work;
  const current = (target?: Selection) => {
    const selected = input.selection();
    if (
      !selected || (target && scopeOf(selected) !== scopeOf(target)) ||
      !input.ready() ||
      !input.panels.available(() => true).some(({ id }) => id === "work")
    ) return;
    return { scope: scopeOf(selected), turns: model(selected)?.turns() ?? [] };
  };
  const reply = (selection: NonNullable<ReturnType<typeof current>>) => {
    const turn = panel.shown(selection.scope, selection.turns).turn;
    return turn === undefined ? undefined : input.lastMessageID(turn);
  };
  ownedCommand(ports, {
    id: "work.show",
    title: "Show in Work log",
    category: "Work log",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
        turn: { type: "string" },
        run: { type: "string", optional: true },
      },
    },
    enabled: (_, target: ShowTarget) =>
      !!current(target)?.turns.includes(target.turn),
    run: async (_, target: ShowTarget) => {
      const selection = current(target);
      if (!selection) return;
      panel.show(selection.scope, target, selection.turns);
      const { rightView, rightCollapsed } = input.layout();
      if (rightView !== "work" || rightCollapsed) {
        await input.saveLayout({ rightView: "work", rightCollapsed: false });
      }
    },
  });
  ownedCommand(ports, {
    id: "work.step",
    title: "Step between replies in Work log",
    category: "Work log",
    arguments: {
      type: "object",
      properties: { delta: { type: "number", enum: [-1, 1] } },
    },
    enabled: () => !!current()?.turns.length,
    run: (_, { delta }: { delta: -1 | 1 }) => {
      const selection = current();
      if (selection) panel.step(selection.scope, delta, selection.turns);
    },
  });
  ownedCommand(ports, {
    id: "work.reply",
    title: "Show reply",
    category: "Work log",
    enabled: () => {
      const selection = current();
      return !!selection && !!reply(selection);
    },
    run: async () => {
      const selection = current();
      const messageID = selection && reply(selection);
      if (!messageID) return;
      const { rightView, rightCollapsed } = input.layout();
      if (
        input.panelPresentation?.() === "sheet" && rightView === "work" &&
        !rightCollapsed
      ) {
        await ports.commands.run("layout.panel.toggle");
        const selected = input.selection();
        if (!selected || scopeOf(selected) !== selection.scope) return;
      }
      await ports.commands.run("transcript.reveal", { messageID });
    },
  });
}
