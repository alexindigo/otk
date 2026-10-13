// SPDX-License-Identifier: LGPL-3.0-only
export interface ModelRef {
  provider: string;
  model: string;
}
export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}
export type Inline =
  | { i: "text"; text: string }
  | { i: "strong" | "em" | "del"; inline: Inline[] }
  | { i: "code"; text: string }
  | { i: "link"; href: string; inline: Inline[] }
  | { i: "image"; src: string; alt: string }
  | { i: "break" };
export type Block =
  | { b: "paragraph"; inline: Inline[] }
  | { b: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: Inline[] }
  | { b: "code"; lang?: string; text: string }
  | {
    b: "list";
    ordered: boolean;
    start?: number;
    items: { task?: boolean; checked?: boolean; blocks: Block[] }[];
  }
  | { b: "quote"; blocks: Block[] }
  | {
    b: "table";
    align: ("left" | "center" | "right" | null)[];
    header: Inline[][];
    rows: Inline[][][];
  }
  | { b: "rule" };
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: {
    kind: "context" | "add" | "del";
    text: string;
    oldNo?: number;
    newNo?: number;
  }[];
}
export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "moved";
  additions: number;
  deletions: number;
  hunks: Hunk[];
  diagnostics?: Diagnostic[];
}
export interface ToolBase {
  callID: string;
  status: "pending" | "running" | "completed" | "error" | "denied";
  title?: string;
  error?: string;
  time: { start?: number; end?: number };
  awaitingPermission: boolean;
  childSessionID?: string;
}
export interface BashCall extends ToolBase {
  tool: "bash";
  command: string;
  description?: string;
  cwd?: string;
  output: string;
  exitCode?: number;
}
export interface GenericCall extends ToolBase {
  tool: "generic";
  name: string;
  summary: string;
  output?: string;
  outputTruncated?: boolean;
}
export interface ReadCall extends ToolBase {
  tool: "read";
  path: string;
  offset?: number;
  limit?: number;
  loaded: string[];
}
export interface SearchCall extends ToolBase {
  tool: "search";
  mode: "glob" | "grep" | "list";
  pattern: string;
  path?: string;
  matches: number;
}
export interface FetchCall extends ToolBase {
  tool: "fetch";
  url: string;
  format?: string;
}
// Actual counts belong to the deferred server-owned search feature.
export interface WebSearchCall extends ToolBase {
  tool: "websearch";
  query: string;
  provider?: string;
}
export interface SkillCall extends ToolBase {
  tool: "skill";
  name: string;
}
export interface Diagnostic {
  severity: "error" | "warning" | "info" | "hint";
  line: number;
  col: number;
  message: string;
}
export interface EditCall extends ToolBase {
  tool: "edit";
  path: string;
  files: FileDiff[];
  diagnostics: Diagnostic[];
}
export interface WriteCall extends ToolBase {
  tool: "write";
  path: string;
  content: string;
  lang?: string;
  diagnostics: Diagnostic[];
}
export interface PatchCall extends ToolBase {
  tool: "patch";
  files: FileDiff[];
}
export interface TodoCall extends ToolBase {
  tool: "todo";
  items: Todo[];
}
export interface QuestionCall extends ToolBase {
  tool: "question";
  questions: {
    text: string;
    options: { label: string; description: string }[];
    answer?: string[];
  }[];
}
export type ToolCall =
  | BashCall
  | GenericCall
  | TodoCall
  | QuestionCall
  | ReadCall
  | SearchCall
  | FetchCall
  | WebSearchCall
  | SkillCall
  | FileToolCall
  | TaskCall;
// File-writing tools preserve server-built hunks and never expose LSP types.
export type FileToolCall = EditCall | WriteCall | PatchCall;
export interface TaskCall extends ToolBase {
  tool: "task";
  agent: string;
  description: string;
  currentTool?: string;
  toolCount: number;
  duration?: number;
}
export type Part =
  | { kind: "meta"; id: string }
  | {
    kind: "text";
    id: string;
    blocks: Block[];
    synthetic: boolean;
    streamVersion?: number;
  }
  | {
    kind: "reasoning";
    id: string;
    title?: string;
    blocks: Block[];
    streamVersion?: number;
    time: { start: number; end?: number };
  }
  | { kind: "tool"; id: string; call: ToolCall }
  | {
    kind: "file";
    id: string;
    name: string;
    mime: string;
    path?: string;
    range?: { start: number; end: number };
  }
  | { kind: "agent"; id: string; name: string }
  | {
    kind: "step";
    id: string;
    phase: "start" | "finish";
    tokens?: Tokens;
    cost?: number;
  }
  | { kind: "compaction"; id: string }
  | { kind: "unknown"; id: string; label: string };
export interface UserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent?: string;
  agentColor?: string;
  model?: ModelRef;
  parts: Part[];
}
export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number; lastOutput?: number };
  agent: string;
  agentColor?: string;
  replyTo?: string;
  model: ModelRef;
  tokens: Tokens;
  cost: number;
  error?: { kind: string; message: string };
  interrupted: boolean;
  parts: Part[];
}
export type Message = UserMessage | AssistantMessage;
export interface ContentSession {
  id: string;
  directory: string;
  title: string;
  parentID?: string;
  projectID: string;
  time: { created: number; updated: number };
  archived: boolean;
  revert?: RevertInfo;
  error?: string;
}
export interface RevertInfo {
  messageID: string;
  messageCount: number;
  files: { path: string; additions: number; deletions: number }[];
}
export interface PermissionRequest {
  id: string;
  sessionID: string;
  kind: string;
  title: string;
  patterns: string[];
  alwaysPatterns: string[];
  detail: PermissionDetail;
  toolCall?: string;
  time: number;
}
export type PermissionDetail =
  | { kind: "bash"; command: string; cwd?: string }
  | { kind: "edit"; files: FileDiff[] }
  | { kind: "generic"; summary: string };
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: string;
}
export type ContentOp =
  | { op: "session.error"; error?: string }
  | { op: "question.upsert"; request: QuestionRequest }
  | { op: "question.remove"; requestID: string; sessionID: string }
  | {
    op: "session.revert";
    messageID?: string;
    messageCount: number;
    files: RevertInfo["files"];
  }
  | { op: "message.upsert"; message: Message }
  | { op: "message.remove"; messageID: string }
  | { op: "part.upsert"; messageID: string; part: Part; lastOutput?: number }
  | {
    op: "part.blocks";
    messageID: string;
    partID: string;
    from: number;
    blocks: Block[];
    streamVersion?: number;
    lastOutput?: number;
  }
  | { op: "part.remove"; messageID: string; partID: string }
  | { op: "permission.upsert"; request: PermissionRequest }
  | { op: "permission.remove"; requestID: string; sessionID: string }
  | { op: "todo.set"; items: Todo[] }
  | { op: "diff.set"; files: FileDiff[] };
export type PermissionOp = Extract<
  ContentOp,
  { op: "permission.upsert" | "permission.remove" }
>;
export function isPermissionOp(op: ContentOp): op is PermissionOp {
  return op.op === "permission.upsert" || op.op === "permission.remove";
}
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: {
    header?: string;
    text: string;
    options: { label: string; description?: string }[];
    multiple: boolean;
    custom: boolean;
  }[];
}
export function isAttentionOp(op: ContentOp): boolean {
  return isPermissionOp(op) || op.op === "question.upsert" ||
    op.op === "question.remove";
}
