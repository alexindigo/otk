// SPDX-License-Identifier: LGPL-3.0-only
import type { ApprovalModel, CommandHub } from "@otk/client";
import type { SessionContextTarget } from "../../features/session-context.ts";

export interface ApprovalCommandTarget {
  model: ApprovalModel;
  sessionID: string;
  connected: boolean;
}
/** Capture the invocation target once; a late RPC never toggles another session. */
export function registerApprovalCommands(commands: CommandHub, ports: {
  current(input?: SessionContextTarget): ApprovalCommandTarget | undefined;
  beforeEnable(target: ApprovalCommandTarget): boolean;
}): () => void {
  return commands.register({
    id: "permission.auto",
    title: "Toggle session auto-approve",
    category: "Attention",
    context: {
      kind: "session",
      title: (input: SessionContextTarget) => {
        const target = ports.current(input);
        return target?.model.owner(target.sessionID)
          ? "Turn auto-approve off"
          : "Turn auto-approve on";
      },
      order: 30,
    },
    enabled: (_ctx, input?: SessionContextTarget) => {
      const target = ports.current(input);
      return !!target?.connected && target.model.state.ready;
    },
    async run(_ctx, input?: SessionContextTarget) {
      const target = ports.current(input);
      if (!target?.connected) {
        throw new Error("Session approvals are unavailable");
      }
      const enabled = !target.model.owner(target.sessionID);
      if (enabled && !ports.beforeEnable(target)) return;
      await target.model.setAuto(target.sessionID, enabled);
    },
  });
}
