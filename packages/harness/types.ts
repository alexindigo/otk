// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Capabilities,
  ContentOp,
  ContentSession,
  Message,
} from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import type { HarnessState } from "@otk/protocol";
export type {
  AgentsCapability,
  Capabilities,
  CapabilityName,
  CommandsCapability,
  FilesCapability,
  HistoryAttachmentRef,
  HistoryCapability,
  PermissionsCapability,
  PromptCapability,
  QuestionsCapability,
  ResourcesCapability,
  RevertCapability,
  ShellCapability,
} from "@otk/protocol";
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
export interface Harness {
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
}
export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
