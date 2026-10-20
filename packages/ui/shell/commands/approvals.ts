// SPDX-License-Identifier: LGPL-3.0-only
import type { ApprovalModel, CommandHub } from "@otk/client";

export interface ApprovalCommandTarget {
  model: ApprovalModel;
  sessionID: string;
  connected: boolean;
}
/** Capture the invocation target once; a late RPC never toggles another session. */
export function registerApprovalCommands(commands: CommandHub, ports: {
  current(): ApprovalCommandTarget | undefined;
  beforeEnable(target: ApprovalCommandTarget): boolean;
}): () => void {
  return commands.register({
    id: "permission.auto",
    title: "Toggle session auto-approve",
    category: "Attention",
    enabled: () => {
      const target = ports.current();
      return !!target?.connected && target.model.state.ready;
    },
    async run() {
      const target = ports.current();
      if (!target?.connected) {
        throw new Error("Session approvals are unavailable");
      }
      const enabled = !target.model.owner(target.sessionID);
      if (enabled && !ports.beforeEnable(target)) return;
      await target.model.setAuto(target.sessionID, enabled);
    },
  });
}
