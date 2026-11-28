// SPDX-License-Identifier: LGPL-3.0-only
import type { Note } from "./notifications.ts";
import {
  SERVER_RELOAD,
  SERVER_RELOAD_LABEL,
  serverProblem,
} from "./server-continuity.ts";
import type { SidecarState } from "./sidecars.ts";

export function serverNote(
  { id, label, continuity }: Pick<SidecarState, "id" | "label" | "continuity">,
  local: boolean,
): Note | undefined {
  const owner = local ? "OTK" : label;
  const problem = serverProblem(continuity, owner);
  if (problem) {
    return {
      id: `server/${id}`,
      kind: "server",
      title: problem.title,
      body: problem.refusal ?? problem.body,
      dismissalKey: problem.key,
      actions: [{
        label: SERVER_RELOAD_LABEL,
        command: SERVER_RELOAD,
        args: { sidecarId: id },
        default: true,
      }],
    };
  }
  const restart = continuity?.kind === "live" && continuity.restarted;
  if (restart) {
    return {
      id: `server/${id}`,
      kind: "info",
      title: restart.updated
        ? `${owner} was updated`
        : local
        ? "OTK server restarted"
        : `${label} restarted`,
      body: "Reconnected",
      dismissalKey: `restarted:${restart.instance}`,
      actions: [],
    };
  }
}
