// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, SessionActions } from "@otk/client";
import type { PermissionReply } from "@otk/protocol";
export function registerAttentionCommands(
  commands: CommandHub,
  actions: Pick<SessionActions, "permission" | "question">,
): () => void {
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
