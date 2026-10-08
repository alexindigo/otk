// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentOp,
  ContentSession,
  Message,
  PermissionRequest,
} from "../../protocol/content.ts";
import type { IndexEntry } from "../../protocol/index.ts";
import type { HarnessState } from "../../protocol/messages.ts";
import type { PermissionReply, PromptInput } from "../../protocol/rpc.ts";
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
  listMessages(
    id: string,
    opts: { before?: string; limit: number },
  ): Promise<Message[]>;
  createSession(
    input: { directory: string; title?: string; parentID?: string },
  ): Promise<ContentSession>;
  prompt(input: PromptInput): Promise<void>;
  abort(sessionID: string): Promise<void>;
  replyPermission(input: PermissionReply): Promise<void>;
  listPermissions(sessionID: string): Promise<PermissionRequest[]>;
}
export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
