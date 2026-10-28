// SPDX-License-Identifier: LGPL-3.0-only
import { useCommandPorts } from "../keyboard/context.tsx";
import { useShellPorts } from "../shell/context.tsx";
import type { PanelDefinition, SurfaceRegistry } from "../registries/shell.ts";
import ProjectSessions from "../components/ProjectSessions.tsx";
import { SessionsIcon } from "../components/ChromeIcons.tsx";

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
        <ProjectSessions
          project={shell.project()}
          entries={shell.entries()}
          selected={shell.selection()}
          rename={shell.rename}
          showCost={shell.toggles.state.prefs.showCost}
          auto={(id) =>
            !!shell.project() &&
            !!shell.approvals(shell.project()!.sidecarId).owner(id)}
          cost={(sessionID) => {
            const project = shell.project();
            return shell.toggles.state.prefs.showCost && project
              ? shell.entries().find((entry) =>
                entry.sidecarId === project.sidecarId &&
                entry.id === sessionID && entry.digest.state === "ready"
              )?.digest.total?.cost ?? undefined
              : undefined;
          }}
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
    },
  });
}
