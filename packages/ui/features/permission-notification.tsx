// SPDX-License-Identifier: LGPL-3.0-only
import { type Note, notePermission } from "@otk/client";
import { Show } from "solid-js";
import PermissionSummary from "../components/PermissionSummary.tsx";

/** Injected toast content; the generic toast host knows no permission schema. */
export function permissionNotificationDetail(note: Note) {
  return (
    <Show when={notePermission(note)}>
      {(request) => <PermissionSummary request={request()} />}
    </Show>
  );
}
