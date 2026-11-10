// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionRequest, ToolCall } from "@otk/protocol";
import { belongsToSession, type SessionLookup } from "@otk/protocol";
export function oldestPermission(
  requests: PermissionRequest[],
  sessionID: string,
  lookup: SessionLookup,
): PermissionRequest | undefined {
  return requests.filter((request) =>
    belongsToSession(request.sessionID, sessionID, lookup)
  ).sort((a, b) => a.time - b.time)[0];
}
/** Pending edit previews are authoritative until the tool supplies a settled result. */
export function permissionTool(
  call: ToolCall,
  requests: readonly PermissionRequest[],
): ToolCall {
  if (
    (call.tool !== "edit" && call.tool !== "patch") ||
    call.status === "completed" || call.status === "error" ||
    call.status === "denied"
  ) return call;
  const request = requests.find((request) =>
    request.toolCall === call.callID && request.detail.kind === "edit"
  );
  return request?.detail.kind === "edit"
    ? { ...call, files: request.detail.files }
    : call;
}
