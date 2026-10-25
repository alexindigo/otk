// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "../content.ts";

export interface SessionActionsCapability {
  rename(sessionID: string, title: string): Promise<ContentSession>;
  remove(sessionID: string): Promise<void>;
  /** Include through and everything before it; absent = visible conversation. */
  fork(sessionID: string, through?: string): Promise<ContentSession>;
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
}
