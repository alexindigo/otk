// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, Show } from "solid-js";
import { useShellPorts } from "../shell/context.tsx";
import type { PanelDefinition, SurfaceRegistry } from "../registries/shell.ts";
import PermissionActivity from "../components/PermissionActivity.tsx";
import { ActivityIcon } from "../components/ChromeIcons.tsx";

export function registerActivityPanel(
  registry: SurfaceRegistry<PanelDefinition>,
): void {
  registry.register({
    id: "activity",
    title: "Activity",
    icon: ActivityIcon,
    capability: "permissions",
    component: () => {
      const shell = useShellPorts();
      const target = () => shell.selection();
      const owner = () => {
        const selected = target();
        return selected && shell.approvals(selected.sidecarId);
      };
      createEffect(
        () => ({ target: target(), ready: owner()?.state.ready }),
        ({ target, ready }) => {
          if (target && ready) {
            void shell.approvals(target.sidecarId).selectActivity(
              target.sessionID,
            );
          }
        },
      );
      return (
        <Show
          when={target()}
          fallback={
            <p class="otk-muted">Choose a session to view its activity.</p>
          }
        >
          <PermissionActivity
            value={owner()!.activityFor(target()!.sessionID)}
            title={(id) =>
              shell.entries().find((entry) =>
                entry.sidecarId === target()!.sidecarId && entry.id === id
              )?.title ?? id}
            onMore={() => owner()!.loadActivity(target()!.sessionID, true)}
            onRetry={() => owner()!.loadActivity(target()!.sessionID)}
          />
        </Show>
      );
    },
  });
}
