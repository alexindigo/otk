// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionErrorState } from "./errors.ts";
import type { HistoryEntry } from "./history.ts";
import type { StreamStamp } from "./transcript.ts";
/** A concrete hex colour or a semantic role, resolved by the consumer's theme. */
export type AgentColor = `#${string}` | "accent" | "secondary";
export interface ModelRef {
  provider: string;
  model: string;
}
export interface PromptSelection {
  agent?: string;
  model?: ModelRef;
  variant?: string;
}
/** A model selection replaces its variant, including the default (absent) one. */
export function mergePromptSelection<T extends PromptSelection>(
  current: T,
  patch: PromptSelection,
): Omit<T, keyof PromptSelection> & PromptSelection {
  return {
    ...current,
    ...patch,
    ...(patch.model ? { variant: patch.variant } : {}),
  };
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
  path?: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "moved" | "unknown";
  additions: number;
  deletions: number;
  hunks: Hunk[];
  diagnostics?: Diagnostic[];
}
/** User-facing results decoded by the native adapter, never model envelopes. */
export type ToolResult =
  | {
    kind: "file";
    text: string;
    lang?: string;
    startLine: number;
    endLine: number;
    totalLines?: number;
    truncated: boolean;
  }
  | {
    kind: "paths";
    paths: string[];
    offset?: number;
    total?: number;
    truncated: boolean;
  }
  | {
    kind: "matches";
    matches: { path: string; line: number; text: string }[];
    truncated: boolean;
  }
  | { kind: "skill"; text: string; directory: string; paths: string[] }
  | { kind: "text"; text: string }
  | { kind: "blocks"; blocks: Block[] };
export interface ToolBase {
  callID: string;
  source?: NativeSource;
  /** Original tool label when a source operation is normalized to a shared kind. */
  sourceName?: string;
  status: "pending" | "running" | "completed" | "error" | "denied";
  title?: string;
  error?: string;
  time: { start?: number; end?: number };
  childSessionID?: string;
  /** Native result text, when supplied; structural tools also retain their typed result. */
  output?: string;
  outputContent?: ToolResult;
  selectionIntent?: { agent: string };
}
export interface BashCall extends ToolBase {
  tool: "bash";
  command: string;
  description?: string;
  cwd?: string;
  output: string;
  exitCode?: number;
  outputBytes?: number;
  outputTruncated?: boolean;
}
/** Harness/plugin names occupy a separate namespace from typed OTK tools. */
export interface ExternalCall extends ToolBase {
  tool: "external";
  name: string;
  summary: string;
  /** Bounded JSON previews, not necessarily parseable after truncation. */
  input?: string;
  metadata?: string;
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
  pattern?: string;
  path?: string;
  matches?: number;
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
/** Features can contribute typed tools through declaration merging. */
export interface ToolKinds {
  bash: BashCall;
  todo: TodoCall;
  question: QuestionCall;
  read: ReadCall;
  search: SearchCall;
  fetch: FetchCall;
  websearch: WebSearchCall;
  skill: SkillCall;
  edit: EditCall;
  write: WriteCall;
  patch: PatchCall;
  task: TaskCall;
}
export type ToolCall = ToolKinds[keyof ToolKinds] | ExternalCall;
// File-writing tools preserve server-built hunks and never expose LSP types.
export type FileToolCall = EditCall | WriteCall | PatchCall;
export interface TaskCall extends ToolBase {
  tool: "task";
  agent?: string;
  description: string;
  progress?: import("./transcript.ts").HelperSummary;
  duration?: number;
}
/** Features can contribute typed parts without changing a central union. */
export interface PartKinds {
  meta: { kind: "meta"; id: string; source?: NativeSource };
  text: {
    kind: "text";
    id: string;
    source?: NativeSource;
    blocks: Block[];
    synthetic: boolean;
    stream?: StreamStamp;
  };
  reasoning: {
    kind: "reasoning";
    id: string;
    source?: NativeSource;
    title?: string;
    blocks: Block[];
    stream?: StreamStamp;
    time: { start: number; end?: number };
  };
  tool: { kind: "tool"; id: string; call: ToolCall; source?: NativeSource };
  file: {
    kind: "file";
    id: string;
    source?: NativeSource;
    name: string;
    mime: string;
    /** Original display source, when supplied by the backend. */
    url?: string;
    path?: string;
    range?: { start: number; end: number };
  };
  agent: { kind: "agent"; id: string; name: string; source?: NativeSource };
  step: {
    kind: "step";
    id: string;
    source?: NativeSource;
    phase: "start" | "finish";
    tokens?: Tokens;
    cost?: number;
  };
  compaction: {
    kind: "compaction";
    id: string;
    source?: NativeSource;
    /** Provider lifecycle, independent of whether this context is a prompt. */
    status?: "queued" | "running" | "completed" | "failed";
  };
  unknown: {
    kind: "unknown";
    id: string;
    label: string;
    source?: NativeSource;
  };
}
/** Native keys and wording are opaque. Null facts never imply settlement or success. */
export interface ActivityState {
  key: string;
  label: string;
  facts: { active: boolean | null; terminal: boolean | null };
}
export interface ChildRef {
  sessionID: string;
  label: string;
}
export interface ActivityParameter {
  key: string;
  label: string;
  value: string;
  child?: ChildRef;
}
export type DisclosureCategory =
  | "work"
  | "toolOutput"
  | "reasoning"
  | "fileChanges"
  | "system"
  | "delegation"
  | "outgoing"
  | "compaction"
  | "record"
  | "source";
/** Bounded inspection preview plus optional exact sent/received text for Copy. */
export interface NativeSource {
  kind: string;
  preview: string;
  bytes: number;
  truncated: boolean;
  payload?: string;
}
export interface Activity {
  kindLabel: string;
  layout: "row" | "boundary";
  direction?: "outgoing";
  category: DisclosureCategory;
  state?: ActivityState;
  tone: "normal" | "error";
  title: string;
  detail?: string;
  parameters?: ActivityParameter[];
  body?: Block[];
  child?: ChildRef;
  icon?: { name: string; label?: string };
}
/** Unrecognized harness parts retain their name and bounded data preview. */
export interface ExternalPart {
  kind: "external";
  id: string;
  name: string;
  data?: string;
  activity?: Activity;
  source?: NativeSource;
}
export type Part = PartKinds[keyof PartKinds] | ExternalPart;
export interface UserMessage {
  id: string;
  sessionID: string;
  role: "user";
  source?: NativeSource;
  /** Provider chronology; IDs and copied timestamps need not be ordered. */
  sourceOrder?: number;
  /** Context is visible, but never a user prompt or composer-selection anchor. */
  origin?:
    | "synthetic"
    | "system"
    | "skill"
    | "shell"
    | "compaction"
    | "external";
  time: { created: number };
  agent?: string;
  agentColor?: AgentColor;
  model?: ModelRef;
  variant?: string;
  parts: Part[];
}
export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  source?: NativeSource;
  sourceOrder?: number;
  time: { created: number; completed?: number; lastOutput?: number };
  agent: string;
  agentColor?: AgentColor;
  replyTo?: string;
  model: ModelRef;
  tokens: import("./digest.ts").ReportedTokens;
  cost: number | null;
  error?: { kind: string; message: string };
  interrupted: boolean;
  parts: Part[];
}
/** A native action boundary, independent of prompt/recall/queue identity. */
export interface RevertBoundary {
  messageID: string;
  affected: { messages: number; prompts: number };
}
export interface ContextMessage {
  id: string;
  sessionID: string;
  role: "context";
  sourceOrder?: number;
  source?: NativeSource;
  time: { created: number };
  parts: Part[];
  revert?: RevertBoundary;
}
export type Message = UserMessage | AssistantMessage | ContextMessage;
export function isRealPrompt(message: Message): message is UserMessage {
  return message.role === "user" && message.origin === undefined;
}
export function compareMessages(a: Message, b: Message): number {
  return a.sourceOrder !== undefined && b.sourceOrder !== undefined
    ? a.sourceOrder - b.sourceOrder || a.id.localeCompare(b.id)
    : a.time.created - b.time.created || a.id.localeCompare(b.id);
}
export interface ContentSession {
  id: string;
  directory: string;
  title: string;
  parentID?: string;
  projectID: string;
  time: { created: number; updated: number };
  archived: boolean;
  selection?: PromptSelection;
  revert?: RevertInfo;
  error?: string;
  errorState?: SessionErrorState;
}
export interface RevertedPrompt {
  messageID: string;
  time: number;
  preview: string;
}
export interface RevertInfo {
  messageID: string;
  messageCount: number;
  files: { path?: string; additions: number; deletions: number }[];
  /** Oldest first, at most 50, whitespace collapsed and at most 200 characters. */
  prompts?: RevertedPrompt[];
  /** Boundary prompt content; attachments retain metadata-only history refs. */
  prompt?: HistoryEntry;
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
  priority?: string;
}
export type ContentOp =
  | { op: "session.selection"; selection: PromptSelection }
  | { op: "stream.reconcile" }
  | {
    op: "stream.recovery";
    messageID: string;
    partID: string;
    generation: number;
    state: "recovering" | "ready" | "unavailable";
  }
  | {
    op: "task.progress";
    messageID: string;
    partID: string;
    childSessionID: string;
    summary: import("./transcript.ts").HelperSummary;
  }
  | { op: "agent.colors"; colors: Record<string, AgentColor> }
  | { op: "session.error"; error?: string; errorState?: SessionErrorState }
  | { op: "question.upsert"; request: QuestionRequest }
  | { op: "question.remove"; requestID: string; sessionID: string }
  | { op: "form.upsert"; request: import("./forms.ts").FormRequest }
  | { op: "form.remove"; requestID: string }
  | {
    op: "session.revert";
    messageID?: string;
    messageCount: number;
    files: RevertInfo["files"];
    prompts?: RevertedPrompt[];
    prompt?: HistoryEntry;
  }
  | {
    op: "message.upsert";
    message:
      Message; /** A producer-observed new attempt of this same message. */
    restart?: boolean;
  }
  | { op: "message.remove"; messageID: string }
  | { op: "message.clock"; messageID: string; lastOutput: number }
  | { op: "part.upsert"; messageID: string; part: Part; lastOutput?: number }
  | {
    op: "part.blocks";
    messageID: string;
    partID: string;
    from: number;
    blocks: Block[];
    stream: StreamStamp;
    baseVersion: number;
    lastOutput?: number;
  }
  | { op: "part.remove"; messageID: string; partID: string }
  | { op: "permission.upsert"; request: PermissionRequest }
  | { op: "permission.remove"; requestID: string; sessionID: string }
  | { op: "todo.set"; items: Todo[] }
  | { op: "diff.set"; files: FileDiff[] };
/** Identity/revision contract shared by sealed pages, indexed clients and standalone reducers. */
export function withHelperProgress(
  part: Part,
  child: string,
  summary: import("./transcript.ts").HelperSummary,
): Part {
  if (
    part.kind !== "tool" || part.call.tool !== "task" ||
    part.call.childSessionID !== child ||
    (part.call.progress?.revision ?? -1) >= summary.revision
  ) return part;
  return { ...part, call: { ...part.call, progress: summary } };
}
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
