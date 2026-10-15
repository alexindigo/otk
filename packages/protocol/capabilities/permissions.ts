// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionRequest } from "../content.ts";
import type { PermissionReply } from "../rpc.ts";
export interface PermissionsCapability {
  replyPermission(input: PermissionReply): Promise<void>;
  listPermissions(sessionID: string): Promise<PermissionRequest[]>;
}
export interface PermissionsCapabilities {
  permissions: PermissionsCapability;
}
export const legacyPermissionsCapabilities:
  readonly (keyof PermissionsCapabilities)[] = ["permissions"];
