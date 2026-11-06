// SPDX-License-Identifier: LGPL-3.0-only
import { useCommandPorts } from "../keyboard/context.tsx";
import { useShellPorts } from "../shell/context.tsx";
import type { PanelDefinition, SurfaceRegistry } from "../registries/shell.ts";
import ProjectSessions from "../components/ProjectSessions.tsx";
import { SessionsIcon } from "../components/ChromeIcons.tsx";
import { Show } from "solid-js";

export function registerSessionsPanel(
  registry: SurfaceRegistry<PanelDefinition>,
): void {
  registry.register({
    id: "sessions",
    title: "Sessions",
    icon: SessionsIcon,
    component: () => {
      const shell = useShellPorts(), { commands } = useCommandPorts();
      return (
        <Show
          fallback={
            <p class="otk-muted">Choose a project to browse its sessions.</p>
          }
          when={shell.project() &&
            JSON.stringify([
              shell.project()!.sidecarId,
              shell.project()!.directory,
            ])}
          keyed
        >
          {(identity) => {
            const [sidecarId, directory] = JSON.parse(identity) as [
              string,
              string,
            ];
            const project = { sidecarId, directory };
            return (
              <ProjectSessions
                project={project}
                ready={shell.inbox(sidecarId).state.ready &&
                  shell.sessionRowsReady(project)}
                metadata={(id) => shell.metadataEntry(sidecarId, id)}
                rows={(query) => shell.sessionRows(project, query)}
                onRows={(keys, query) =>
                  shell.visibleRows(project, keys, query)}
                progress={shell.projectProgress(project)}
                entry={(id) => shell.entry(project.sidecarId, id)}
                interaction={shell.listInteraction(project)}
                selected={shell.selection()}
                rename={shell.rename}
                showCost={shell.toggles.state.prefs.showCost}
                inbox={(id) => shell.inbox(id).state.inbox}
                connected={(id) =>
                  shell.servers().some((s) =>
                    s.id === id && s.status === "connected"
                  )}
                onOpen={(entry) =>
                  commands.run("session.preview", {
                    sidecarId: entry.sidecarId,
                    sessionID: entry.id,
                  })}
                onPin={(entry) =>
                  commands.run("session.pin", {
                    sidecarId: entry.sidecarId,
                    sessionID: entry.id,
                  })}
                onCreate={(project) => commands.run("session.new", project)}
              />
            );
          }}
        </Show>
      );
    },
  });
}
