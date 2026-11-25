// SPDX-License-Identifier: LGPL-3.0-only
import { type Note, notePermission } from "@otk/client";
import PermissionSummary from "../components/PermissionSummary.tsx";

/** Injected toast content; the generic toast host knows no permission schema. */
export function permissionNotificationDetail(note: Note) {
  const request = notePermission(note);
  return request && <PermissionSummary request={request} compact />;
}
