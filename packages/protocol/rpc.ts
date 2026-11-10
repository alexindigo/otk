// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AgentColor,
  ContentSession,
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
import type { ApprovalRpcMethods } from "./approvals.ts";
import type { SessionActionsRpcMethods } from "./capabilities/session-actions.ts";
import type { RestoreRpcMethods } from "./capabilities/restore.ts";
import type { DigestsRpcMethods } from "./capabilities/digests.ts";
import type { RequestMetadata } from "./request-metadata.ts";
import type { CatalogRpcMethods } from "./catalogs.ts";
import type { FormsRpcMethods } from "./forms.ts";
import type {
  HistoryAttachment,
  HistoryAttachmentRef,
} from "./capabilities/history.ts";
export const coreRequestMetadata: Readonly<Record<string, RequestMetadata>> = {
  "session.get": { kind: "read", pending: "Loading conversation" },
  "session.children": { kind: "read", pending: "Loading sessions" },
  "sessions.list": { kind: "read", pending: "Loading sessions" },
  "sessions.identities": { kind: "read", pending: "Checking session" },
  "session.messages": { kind: "read", pending: "Loading messages" },
  "session.create": { kind: "mutation", pending: "Creating session" },
  "session.prompt": { kind: "mutation", pending: "Sending prompt" },
  "session.shell": { kind: "mutation", pending: "Running command" },
  "session.command": { kind: "mutation", pending: "Running command" },
  "session.abort": { kind: "mutation", pending: "Stopping session" },
  "session.revert": { kind: "mutation", pending: "Rolling back" },
  "commands.list": { kind: "read", pending: "Loading commands" },
  "history.list": { kind: "read", pending: "Loading prompt history" },
  "history.attachments": { kind: "read", pending: "Preparing attachments" },
  "find.files": { kind: "read", pending: "Finding files" },
  "agents.list": { kind: "read", pending: "Loading agents" },
  "resources.list": { kind: "read", pending: "Loading resources" },
  "frecency.list": { kind: "read", pending: "Loading recent files" },
  "frecency.bump": {
    kind: "mutation",
    pending: "Saving recent file",
    presentation: "bookkeeping",
  },
  "permission.list": { kind: "read", pending: "Loading requests" },
  "permission.reply": { kind: "mutation", pending: "Sending response" },
  "question.list": { kind: "read", pending: "Loading requests" },
  "question.reply": { kind: "mutation", pending: "Sending answer" },
  "question.reject": { kind: "mutation", pending: "Skipping question" },
  "form.list": { kind: "read", pending: "Loading forms" },
  "form.reply": { kind: "mutation", pending: "Sending answers" },
  "form.cancel": { kind: "mutation", pending: "Cancelling form" },
  "prefs.get": { kind: "read", pending: "Loading settings" },
  "prefs.set": { kind: "mutation", pending: "Saving" },
};
export type PromptPart =
  & (
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
    }
  )
  & { mention?: { start: number; end: number; text: string } };
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
  id?: string;
  name: string;
  description?: string;
  color?: AgentColor;
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
  /** Native skill identity is distinct from its displayed slash name. */
  skillID?: string;
  name: string;
  description?: string;
  aliases: string[];
  source: "server" | "mcp" | "skill" | "builtin" | "unknown";
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
  extends
    InboxRpcMethods,
    LayoutRpcMethods,
    ModelsRpcMethods,
    UsageRpcMethods,
    SessionActionsRpcMethods,
    RestoreRpcMethods,
    DigestsRpcMethods,
    ApprovalRpcMethods,
    CatalogRpcMethods,
    FormsRpcMethods {
  "session.get": {
    params: { sessionID: string };
    result: ContentSession & { load: import("./session-list.ts").LoadCoverage };
  };
  "sessions.list": {
    params: import("./session-list.ts").SessionListInput;
    result: import("./session-list.ts").SessionListPage;
  };
  "sessions.identities": {
    params: { ids: string[] };
    result: { id: string; directory: string; parentID?: string }[];
  };
  "session.children": {
    params: { sessionID: string; before?: string };
    result: import("./session-list.ts").SessionListPage;
  };
  "session.messages": {
    params: import("./transcript.ts").MessagePageInput;
    result: import("./transcript.ts").MessagePage & {
      load: import("./session-list.ts").LoadCoverage;
    };
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
  "history.attachments": {
    params: { refs: HistoryAttachmentRef[] };
    result: { items: HistoryAttachment[] };
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
  "frecency.list": {
    params: { sessionID: string } | { directory: string };
    result: { directory: string; revision: number; entries: FrecencyEntry[] };
  };
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

export interface CreatedSessionReceipt {
  id: string;
  directory: string;
  title: string;
  projectID: string;
  timeCreated: number;
  timeUpdated: number;
  archived: boolean;
  parentID?: string;
}
export interface CoreRequestReceipts {
  "form-replied": { completed: true };
  "form-cancelled": { completed: true };
  "session-created": CreatedSessionReceipt;
  "session-rename-intent": { sessionID: string; title: string };
  "session-boundary-intent": { sessionID: string; messageID: string | null };
  "session-boundary": { sessionID: string; messageID: string | null };
  "prompt-sent": { completed: true };
  "prompt-selection": {
    sessionID: string;
    agent?: string;
    model?: ModelRef;
    variant?: string;
  };
  "shell-settled": { completed: true };
  "command-settled": { completed: true };
  "interrupt-sent": { completed: true };
  "permission-replied": { completed: true };
  "question-replied": { completed: true };
  "question-rejected": { completed: true };
}
