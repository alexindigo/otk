// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession, ModelRef } from "../content.ts";
import type { OperationContext } from "../requests.ts";
import type { CreatedSessionReceipt } from "../rpc.ts";
import type { RequestMetadata } from "../request-metadata.ts";
export const sessionActionsRequestMetadata: Readonly<
  Record<string, RequestMetadata>
> = {
  "session.rename": { kind: "mutation", pending: "Renaming session" },
  "session.delete": { kind: "mutation", pending: "Deleting session" },
  "session.fork": { kind: "mutation", pending: "Forking session" },
  "session.compact": { kind: "mutation", pending: "Compacting session" },
};
export interface SessionActionsRequestReceipts {
  "session-renamed": CreatedSessionReceipt;
  "session-deleted": { completed: true };
  "session-compacted": { completed: true };
}

export interface SessionActionsCapability {
  rename(
    sessionID: string,
    title: string,
    operation?: OperationContext,
  ): Promise<ContentSession>;
  remove(sessionID: string, operation?: OperationContext): Promise<void>;
  /** Include through and everything before it; absent = visible conversation. */
  fork(
    sessionID: string,
    through?: string,
    operation?: OperationContext,
  ): Promise<ContentSession>;
  /** Admits compaction; ordinary session events report its completion. */
  compact(
    sessionID: string,
    model: ModelRef,
    operation?: OperationContext,
  ): Promise<void>;
}
export interface SessionActionsCapabilities {
  sessionActions: SessionActionsCapability;
}
export interface SessionActionsRpcMethods {
  "session.rename": {
    params: { sessionID: string; title: string };
    result: ContentSession;
  };
  "session.delete": { params: { sessionID: string }; result: null };
  "session.fork": {
    params: { sessionID: string; through?: string };
    result: ContentSession;
  };
  "session.compact": {
    params: { sessionID: string; model: ModelRef };
    result: null;
  };
}
