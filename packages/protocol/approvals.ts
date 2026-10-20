// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionReply } from "./rpc.ts";
import type { PermissionRequest } from "./content.ts";
import { sessionAncestors, type SessionLookup } from "./session-tree.ts";

/** Explicit session policies only; descendants inherit through the session index. */
export interface ApprovalSnapshot {
  enabled: string[];
  revision: number;
}
export interface PermissionActivity {
  id: number;
  request: PermissionRequest;
  reply: PermissionReply["reply"];
  source: "manual" | "auto";
  owner?: string;
  message?: string;
  time: number;
  outcome: "started" | "confirmed" | "failed";
  error?: string;
}
export interface PermissionActivityPage {
  entries: PermissionActivity[];
  before?: number;
}
export interface ApprovalRpcMethods {
  "permission.auto": {
    params: { sessionID: string; enabled: boolean };
    result: ApprovalSnapshot;
  };
  "permission.activity": {
    params: { sessionID: string; before?: number };
    result: PermissionActivityPage;
  };
}
/** Helpers inherit; only a writable root session can own an explicit policy. */
export function canAutoApprove(
  session: { parentID?: string } | undefined,
): boolean {
  return !!session && !session.parentID;
}
/** One policy projection shared by the server, browser marks and command owner. */
export function autoApproveOwner(
  sessionID: string,
  enabled: readonly string[],
  lookup: SessionLookup,
): string | undefined {
  return [sessionID, ...sessionAncestors(sessionID, lookup)].find((id) =>
    enabled.includes(id)
  );
}
