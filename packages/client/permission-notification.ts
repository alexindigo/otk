// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionRequest } from "@otk/protocol";
import type { Note } from "./notifications.ts";

interface PermissionNoteDetail {
  type: "otk.permission";
  request: PermissionRequest;
}
/** Permission-owned data travels through the feature-agnostic notification hub. */
export function permissionNoteDetail(
  request: PermissionRequest,
): PermissionNoteDetail {
  return { type: "otk.permission", request };
}
export function notePermission(note: Note): PermissionRequest | undefined {
  const detail = note.detail as PermissionNoteDetail | undefined;
  return note.kind === "permission" && detail?.type === "otk.permission"
    ? detail.request
    : undefined;
}
