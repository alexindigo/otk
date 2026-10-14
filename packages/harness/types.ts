// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentOp,
  ContentSession,
  Message,
  PermissionRequest,
  QuestionRequest,
} from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import type { HarnessState } from "@otk/protocol";
import type {
  CommandInput,
  CommandOption,
  PermissionReply,
  PromptInput,
  PromptPart,
  ShellInput,
} from "@otk/protocol";
import type { HistoryEntry } from "@otk/protocol";
import type { AgentOption, FileMatch, ResourceOption } from "@otk/protocol";
export interface HarnessSink {
  connection(state: HarnessState): void;
  indexReset(entries: IndexEntry[]): void;
  indexUpsert(entry: IndexEntry): void;
  indexRemove(sessionID: string): void;
  content(sessionID: string, op: ContentOp): void;
  resync(sessionIDs: "all"): void;
}
export interface HarnessCore {
  readonly kind: string;
  readonly version: string;
  start(sink: HarnessSink): Promise<void>;
  stop(): Promise<void>;
  subscriptions(sessionID: string, count: number): void;
  getSession(id: string): Promise<ContentSession>;
  listChildren(id: string): Promise<ContentSession[]>;
  listMessages(
    id: string,
    opts: { before?: string; limit: number },
  ): Promise<Message[]>;
  createSession(
    input: { directory: string; title?: string; parentID?: string },
  ): Promise<ContentSession>;
}
export interface PromptCapability {
  prompt(input: PromptInput): Promise<void>;
  abort(sessionID: string): Promise<void>;
}
export interface ShellCapability {
  shell(input: ShellInput): Promise<void>;
}
export interface CommandsCapability {
  command(input: CommandInput): Promise<void>;
  listCommands(sessionID: string): Promise<CommandOption[]>;
}
export interface HistoryAttachmentRef {
  messageID: string;
  partID: string;
}
export interface HistoryCapability {
  listHistory(): Promise<HistoryEntry[]>;
  attachment(
    ref: HistoryAttachmentRef,
  ): Promise<Extract<PromptPart, { source: "upload" }>>;
}
export interface FilesCapability {
  findFiles(sessionID: string, query: string): Promise<FileMatch[]>;
}
export interface AgentsCapability {
  listAgents(sessionID: string): Promise<AgentOption[]>;
}
export interface ResourcesCapability {
  listResources(sessionID: string): Promise<ResourceOption[]>;
}
export interface PermissionsCapability {
  replyPermission(input: PermissionReply): Promise<void>;
  listPermissions(sessionID: string): Promise<PermissionRequest[]>;
}
export interface QuestionsCapability {
  listQuestions(sessionID: string): Promise<QuestionRequest[]>;
  answerQuestion(requestID: string, answers?: string[][]): Promise<void>;
}
export interface RevertCapability {
  revert(sessionID: string, messageID: string): Promise<ContentSession>;
}
export interface Capabilities {
  prompt?: PromptCapability;
  shell?: ShellCapability;
  commands?: CommandsCapability;
  history?: HistoryCapability;
  files?: FilesCapability;
  agents?: AgentsCapability;
  resources?: ResourcesCapability;
  permissions?: PermissionsCapability;
  questions?: QuestionsCapability;
  revert?: RevertCapability;
}
export type CapabilityName = keyof Capabilities;
export interface Harness {
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
}
export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
