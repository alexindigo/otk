// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef } from "./content.ts";
export type PromptPart =
  | { kind: "text"; text: string }
  | {
    kind: "file";
    source: "upload";
    name: string;
    mime: string;
    dataBase64: string;
  }
  | {
    kind: "file";
    source: "path";
    path: string;
    range?: { start: number; end: number };
  }
  | { kind: "agent"; name: string };
export interface PromptInput {
  sessionID: string;
  parts: PromptPart[];
  mode: "normal" | "shell";
  agent?: string;
  model?: ModelRef;
  variant?: string;
}
export interface PermissionReply {
  requestID: string;
  sessionID: string;
  reply: "once" | "always" | "reject";
  message?: string;
}
export interface ShellInput {
  sessionID: string;
  command: string;
  agent?: string;
  model?: ModelRef;
}
export type RpcMethod =
  | "session.get"
  | "session.children"
  | "session.messages"
  | "session.create"
  | "session.prompt"
  | "session.shell"
  | "find.files"
  | "session.abort"
  | "session.revert"
  | "permission.list"
  | "question.list"
  | "question.reply"
  | "question.reject"
  | "permission.reply"
  | "prefs.get"
  | "prefs.set";
