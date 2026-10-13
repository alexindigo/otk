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
export interface HarnessAdapter {
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
  prompt(input: PromptInput): Promise<void>;
  shell(input: ShellInput): Promise<void>;
  command(input: CommandInput): Promise<void>;
  listCommands(sessionID: string): Promise<CommandOption[]>;
  listHistory(): HistoryEntry[];
  historyAttachment(
    messageID: string,
    partID: string,
  ): Extract<PromptPart, { source: "upload" }>;
  findFiles(sessionID: string, query: string): Promise<FileMatch[]>;
  listAgents(sessionID: string): Promise<AgentOption[]>;
  listResources(sessionID: string): Promise<ResourceOption[]>;
  abort(sessionID: string): Promise<void>;
  revert(sessionID: string, messageID: string): Promise<ContentSession>;
  replyPermission(input: PermissionReply): Promise<void>;
  listPermissions(sessionID: string): Promise<PermissionRequest[]>;
  listQuestions(sessionID: string): Promise<QuestionRequest[]>;
  answerQuestion(requestID: string, answers?: string[][]): Promise<void>;
}
export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
