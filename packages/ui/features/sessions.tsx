// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createMemo } from "solid-js";
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
      const entries = createMemo(() => {
        const project = shell.project();
        return shell.entries().filter((entry) =>
          entry.sidecarId === project?.sidecarId &&
          entry.directory === project.directory
        );
      });
      createEffect(() => {
        const server = shell.servers().find((server) =>
          server.id === shell.project()?.sidecarId
        );
        return server?.status === "connected" &&
            server.capabilities.includes("usage")
          ? entries()
          : [];
      }, (rows) => {
        for (const entry of rows) {
          void shell.usage.load({
            sidecarId: entry.sidecarId,
            sessionID: entry.id,
          });
        }
      });
      return (
        <ProjectSessions
          project={shell.project()}
          entries={shell.entries()}
          selected={shell.selection()}
          cost={(sessionID) => {
            const project = shell.project();
            return shell.toggles.state.prefs.showCost && project
              ? shell.usage.get({ sidecarId: project.sidecarId, sessionID })
                ?.total.cost
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
