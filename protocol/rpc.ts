// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "./content.ts";
export interface PromptInput {
  sessionID: string;
  parts: { type: "text"; text: string }[];
  agent?: string;
  model?: ModelRef;
}
export interface PermissionReply {
  requestID: string;
  sessionID: string;
  reply: "once" | "always" | "reject";
  message?: string;
}
export type RpcMethod =
  | "session.get"
  | "session.messages"
  | "session.create"
  | "session.prompt"
  | "session.abort"
  | "permission.list"
  | "permission.reply";
