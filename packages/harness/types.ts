// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Capabilities,
  ContentClock,
  ContentOp,
  ContentSession,
  MessageCursor,
  MessagePage,
  OperationContext,
  TranscriptInvalidation,
} from "@otk/protocol";
import type { SessionMetadata } from "@otk/protocol";
import type { HarnessState } from "@otk/protocol";
import type { SessionIndex } from "./index.ts";
export type {
  AgentsCapability,
  Capabilities,
  CapabilityName,
  CommandsCapability,
  DigestsCapability,
  FilesCapability,
  HistoryAttachmentRef,
  HistoryCapability,
  ModelsCapability,
  OperationContext,
  PermissionsCapability,
  PromptCapability,
  QuestionsCapability,
  ResourcesCapability,
  RevertCapability,
  ShellCapability,
  UsageCapability,
} from "@otk/protocol";
export interface HarnessSink {
  /** When provided, index callbacks write this same authoritative owner. */
  readonly index?: SessionIndex;
  connection(state: HarnessState): void;
  indexReset(entries: SessionMetadata[]): void;
  indexUpsert(entry: SessionMetadata): void;
  indexRemove(sessionID: string): void;
  /** Complete scalar catalog/activity authority, independently of digest readiness. */
  projectAuthority?(activity: "current" | "unknown"): void;
  content(sessionID: string, op: ContentOp, clock?: ContentClock): void;
  bootstrapComplete(): void;
  invalidate(value: TranscriptInvalidation): void;
}
export interface SessionIdentity {
  id: string;
  directory: string;
  parentID?: string;
}
export interface HarnessCore {
  readonly kind: string;
  readonly version: string;
  start(sink: HarnessSink): Promise<void>;
  stop(): Promise<void>;
  subscriptions(sessionID: string, count: number): void;
  identities(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<SessionIdentity[]>;
  getSession(id: string, signal?: AbortSignal): Promise<ContentSession>;
  listSessions(
    input: import("@otk/protocol").SessionListInput,
    signal?: AbortSignal,
  ): Promise<import("./session-lists.ts").SessionListResult>;
  listChildren(id: string, signal?: AbortSignal): Promise<ContentSession[]>;
  listMessages(
    id: string,
    opts: { before?: MessageCursor },
    signal?: AbortSignal,
  ): Promise<MessagePage>;
  createSession(
    input: { directory: string; title?: string; parentID?: string },
    operation?: OperationContext,
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
