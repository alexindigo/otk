// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentSession,
  Message,
  ModelRef,
  PermissionRequest,
  QuestionRequest,
} from "./content.ts";
import type { HistoryEntry } from "./history.ts";
import type { Preferences } from "./prefs.ts";
import type { InboxRpcMethods } from "./inbox.ts";
import type { LayoutRpcMethods } from "./preferences/layout.ts";
import type { ModelsRpcMethods } from "./models.ts";
import type { UsageRpcMethods } from "./usage.ts";
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
    label?: string;
    range?: { start: number; end?: number };
  }
  | { kind: "agent"; name: string }
  | {
    kind: "file";
    source: "resource";
    name: string;
    mime: string;
    uri: string;
    server: string;
    label?: string;
  }
  | {
    kind: "file";
    source: "history";
    name: string;
    mime: string;
    size: number;
    messageID: string;
    partID: string;
    sidecarID?: string;
  };
export interface PromptInput {
  sessionID: string;
  parts: PromptPart[];
  mode: "normal" | "shell";
  agent?: string;
  model?: ModelRef;
  variant?: string;
}
export interface FileMatch {
  path: string;
  directory: boolean;
}
export interface AgentOption {
  name: string;
  description?: string;
  color?: string;
  model?: ModelRef;
  variant?: string;
}
export interface ResourceOption {
  name: string;
  description?: string;
  mime: string;
  uri: string;
  server: string;
}
export interface FrecencyEntry {
  path: string;
  score: number;
  last: number;
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
export interface CommandOption {
  name: string;
  description?: string;
  aliases: string[];
  source: "server" | "mcp" | "skill" | "builtin";
}
export interface CommandInput {
  sessionID: string;
  command: string;
  arguments: string;
  agent?: string;
  model?: ModelRef;
  variant?: string;
  parts?: Extract<PromptPart, { kind: "file" }>[];
}
/** Wire contracts. Features extend this interface through module augmentation. */
export interface RpcMethods
  extends InboxRpcMethods, LayoutRpcMethods, ModelsRpcMethods, UsageRpcMethods {
  "session.get": { params: { sessionID: string }; result: ContentSession };
  "session.children": {
    params: { sessionID: string };
    result: ContentSession[];
  };
  "session.messages": {
    params: { sessionID: string; limit: number; before?: string };
    result: Message[];
  };
  "session.create": {
    params: { directory: string; title?: string; parentID?: string };
    result: ContentSession;
  };
  "session.prompt": { params: PromptInput; result: null };
  "session.shell": { params: ShellInput; result: null };
  "session.command": {
    params: Omit<CommandInput, "arguments"> & { arguments?: string };
    result: null;
  };
  "commands.list": { params: { sessionID: string }; result: CommandOption[] };
  "history.list": { params: Record<string, never>; result: HistoryEntry[] };
  "history.attachment": {
    params: { messageID: string; partID: string };
    result: Extract<PromptPart, { source: "upload" }>;
  };
  "find.files": {
    params: { sessionID: string; query?: string };
    result: FileMatch[];
  };
  "agents.list": {
    params: { sessionID: string; primary?: boolean };
    result: AgentOption[];
  };
  "resources.list": { params: { sessionID: string }; result: ResourceOption[] };
  "frecency.list": { params: { sessionID: string }; result: FrecencyEntry[] };
  "frecency.bump": {
    params: { sessionID: string; path: string };
    result: null;
  };
  "session.abort": { params: { sessionID: string }; result: null };
  "session.revert": {
    params: { sessionID: string; messageID: string };
    result: ContentSession;
  };
  "permission.list": {
    params: { sessionID: string };
    result: PermissionRequest[];
  };
  "question.list": { params: { sessionID: string }; result: QuestionRequest[] };
  "question.reply": {
    params: { requestID: string; answers: string[][] };
    result: null;
  };
  "question.reject": { params: { requestID: string }; result: null };
  "permission.reply": { params: PermissionReply; result: null };
  "prefs.get": { params: Record<string, never>; result: Preferences };
  "prefs.set": {
    // Values are validated by the preference owner, including runtime choices.
    params: { key: keyof Preferences; value: unknown };
    result: Preferences;
  };
}
export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];
