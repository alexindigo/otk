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
      arguments: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          sessionID: { type: "string" },
          reply: { type: "string", enum: ["once", "always", "reject"] },
        },
      },
      run: (_ctx, input: PermissionReply & { sidecarId?: string }) =>
        actions.permission(input),
    }),
    commands.register({
      id: "question.reply",
      title: "Reply to question",
      category: "Attention",
      arguments: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          answers: {
            type: "array",
            optional: true,
            items: { type: "array", items: { type: "string" } },
          },
        },
      },
      run: (_ctx, input: { requestID: string; answers?: string[][] }) =>
        actions.question(input),
    }),
  ];
  return () => releases.forEach((release) => release());
}
