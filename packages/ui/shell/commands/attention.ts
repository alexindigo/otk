// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub } from "@otk/client";
import type { PermissionReply } from "@otk/protocol";
export function registerAttentionCommands(commands: CommandHub, actions: {
  permission(input: PermissionReply & { sidecarId?: string }): Promise<void>;
  question(input: { requestID: string; answers?: string[][] }): Promise<void>;
}): () => void {
  const releases = [
    commands.register({
      id: "permission.reply",
      title: "Reply to permission",
      category: "Attention",
      hidden: true,
      run: (_ctx, input: PermissionReply & { sidecarId?: string }) =>
        actions.permission(input),
    }),
    commands.register({
      id: "question.reply",
      title: "Reply to question",
      category: "Attention",
      hidden: true,
      run: (_ctx, input: { requestID: string; answers?: string[][] }) =>
        actions.question(input),
    }),
  ];
  return () => releases.forEach((release) => release());
}
