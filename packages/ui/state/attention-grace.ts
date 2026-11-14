// SPDX-License-Identifier: LGPL-3.0-only
import { createAttentionGrace, type ServerResources } from "@otk/client";
import { createSignal, onCleanup } from "solid-js";
import type { AttentionPresentation } from "../registries/attention.tsx";
import { solidState } from "./binding.ts";

/** Browser input and accepted-frame binding; no surface owns a grace timer. */
export function attentionPresentation(
  resources: ServerResources,
  animationsOff: () => boolean,
): AttentionPresentation {
  const grace = createAttentionGrace({ factory: solidState });
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const [system, setSystem] = createSignal(media.matches);
  const motion = () => setSystem(media.matches);
  media.addEventListener("change", motion);
  onCleanup(() => {
    media.removeEventListener("change", motion);
    grace.stop();
  });
  onCleanup(resources.observe({
    frame: (server, frame, accepted) => {
      if (!accepted) return;
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        for (const id of resources.indexChanges(server)?.metadata ?? []) {
          const entry = resources.entry(server, id);
          // A scoped metadata eviction is not request settlement.
          if (entry) {
            grace.observe(
              server,
              id,
              entry.deleted
                ? { permissions: { keys: [], fresh: true } }
                : entry.activity,
            );
          }
        }
      }
      if (frame.t === "content") {
        if (frame.event.op === "permission.upsert") {
          const request = frame.event.request;
          grace.permission(server, request.sessionID, request.id);
        } else if (frame.event.op === "permission.remove") {
          grace.settled(server, frame.event.requestID);
        }
      }
    },
    removed: grace.removeServer,
  }));
  return {
    permission: (server, request) =>
      grace.permission(server, request.sessionID, request.id),
    light(scope, state) {
      const contains = (id: string) => {
        if (scope.session) return scope.session === id;
        if (scope.family) {
          return scope.family.contains(id);
        }
        const entry = resources.entry(scope.server, id),
          project = scope.project;
        return !!entry && !!project &&
          (project.repo === entry.projectID ||
            resources.projectDirectory?.(
                scope.server,
                entry.directory,
                entry.projectID,
              ) ===
              project.directory ||
            entry.directory === project.directory);
      };
      const operations = resources.operationAttention?.(scope.server);
      const immediate = !!operations && (
        [...operations.sessions].some(([id, state]) =>
          state === "blocked" && contains(id)
        ) ||
        !!scope.project &&
          operations.projectStates.get(scope.project.directory) === "blocked"
      );
      return grace.light(
        JSON.stringify([
          scope.server,
          scope.session ? "session" : scope.family ? "family" : "project",
          scope.session ?? scope.family?.id ?? scope.project?.directory,
        ]),
        state,
        scope.server,
        contains,
        system() || animationsOff(),
        immediate,
        (id) => resources.attention(scope.server).waiting(id),
      );
    },
  };
}
