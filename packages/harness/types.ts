// SPDX-License-Identifier: LGPL-3.0-only
import { FailureCause, type FailureFacts } from "@otk/protocol";
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
  /** Persisted unseen identities, not the retained population. */
  readonly retainedSessions?: readonly string[];
  connection(state: HarnessState): void;
  indexReset(entries: SessionMetadata[]): void;
  indexUpsert(entry: SessionMetadata): void;
  indexRemove(sessionID: string): void;
  /** Complete scalar catalog/activity authority, independently of digest readiness. */
  projectAuthority?(activity: "current" | "unknown"): void;
  projectSeeds?(projects: readonly ProjectSeed[]): void;
  content(sessionID: string, op: ContentOp, clock?: ContentClock): void;
  bootstrapComplete(): void;
  invalidate(value: TranscriptInvalidation): void;
}
export interface ProjectSeed {
  directory: string;
  /** Native facts for the core identity owner; one per distinct native owner. */
  identities?: readonly ProjectIdentityFact[];
  /** Compatibility for injected harnesses; removal never erases learned ownership. */
  topology?: import("@otk/protocol").ProjectTopology | null;
  /** Omitted when native population authority is unavailable. */
  hasSessions?: boolean;
  sessionCount: number | null;
  lastActivity: number | null;
  authority: "current" | "stale" | "unknown";
}
export interface ProjectIdentityFact {
  /** Persistent native source identity, independent of current connection. */
  source: string;
  repoID: string;
  canonicalRoot?: string;
  /** Null means unrecorded; an empty native subpath instead proves an exact root. */
  recordedRoot?: string | null;
  historicalRoots?: readonly string[];
  /** Undefined is a failed/unsupported read, never an authoritative empty set. */
  inventory?: readonly {
    directory: string;
    kind: "checkout" | "worktree" | "unknown";
  }[];
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
  hydrate?(ids: readonly string[], signal?: AbortSignal): Promise<void>;
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
    opts: { before?: MessageCursor; publish?(page: MessagePage): void },
    signal?: AbortSignal,
  ): Promise<MessagePage>;
  createSession(
    input: { directory: string; title?: string; parentID?: string },
    operation?: OperationContext,
  ): Promise<ContentSession>;
}
export interface Harness {
  /** Composition injects this plugin's isolated, semantics-free storage before start. */
  storage?(storage: import("./plugin-storage.ts").PluginStorage): void;
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
}
export class HarnessError extends FailureCause {
  /** Feature-authored semantic reason; arbitrary/native causes remain separate. */
  constructor(
    readonly code: string,
    message: string,
    facts: FailureFacts = { reason: message },
  ) {
    super(message, facts);
  }
}
