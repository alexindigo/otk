// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";
export const ACTIVITY_PAGE_SIZE = 100;
export const approvalsRequestMetadata: Readonly<
  Record<string, RequestMetadata>
> = {
  "permission.auto": { kind: "mutation", pending: "Saving auto-approve" },
  "permission.activity": { kind: "read", pending: "Loading activity" },
};
import type { PermissionReply } from "./rpc.ts";
import type { PermissionRequest } from "./content.ts";
import type { SessionLookup } from "./session-tree.ts";

/** Explicit session policies only; descendants inherit through the session index. */
export interface ApprovalSnapshot {
  enabled: string[];
  revision: number;
}
export interface ApprovalRequestReceipts {
  "approval-policy": ApprovalSnapshot;
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
  session: { parentID?: string; deleted?: unknown } | undefined,
): boolean {
  return !!session && !session.parentID && !session.deleted;
}
/** One policy projection shared by the server, browser marks and command owner. */
export function autoApproveOwner(
  sessionID: string,
  enabled: readonly string[],
  lookup: SessionLookup,
  cache?: Map<string, string | undefined>,
): string | undefined {
  const path: string[] = [], seen = new Set<string>(), keys = new Set(enabled);
  let id: string | undefined = sessionID, owner: string | undefined;
  while (id && !seen.has(id)) {
    if (keys.has(id)) {
      owner = id;
      break;
    }
    if (cache?.has(id)) {
      owner = cache.get(id);
      break;
    }
    seen.add(id);
    path.push(id);
    id = lookup(id)?.parentID;
  }
  for (const id of path) cache?.set(id, owner);
  return owner;
}
