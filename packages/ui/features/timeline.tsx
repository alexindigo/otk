// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo } from "solid-js";
import { collectionState, sessionRunning, timelinePrompts } from "@otk/client";
import { entityKey } from "@otk/protocol";
import { useShellPorts } from "../shell/context.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import type { PanelDefinition, SurfaceRegistry } from "../registries/shell.ts";
import Timeline from "../components/Timeline.tsx";
import { TimelineIcon } from "../components/ChromeIcons.tsx";
import { messageFrames } from "../components/work-log.ts";

export function registerTimelinePanel(
  registry: SurfaceRegistry<PanelDefinition>,
): void {
  registry.register({
    id: "timeline",
    title: "Timeline",
    icon: TimelineIcon,
    component: () => {
      const shell = useShellPorts();
      const { parts } = useUiRegistries();
      const prompts = createMemo(() => {
        const target = shell.selection();
        return timelinePrompts(
          shell.transcript.messages(),
          !!target &&
            sessionRunning(
              shell.inbox(target.sidecarId).entities,
              entityKey("session", target.sessionID),
            ),
        ).filter((prompt) =>
          messageFrames(
            { ...prompt, role: "user" },
            (part) => parts.presentation(part, shell.toggles.state.prefs),
          ).prompt
        );
      });
      return (
        <Timeline
          session={shell.selection()}
          prompts={prompts()}
          state={collectionState(
            shell.transcript.answered?.() === true,
            prompts().length,
          )}
          exhausted={shell.transcript.exhausted()}
          paging={shell.transcript.paging()}
          preview={(prompt) =>
            prompt.parts.map((part) =>
              parts.presentation(part, shell.toggles.state.prefs).text
            ).filter(Boolean).join("\n\n")}
          directory={shell.entries().find((entry) =>
            entry.sidecarId === shell.selection()?.sidecarId &&
            entry.id === shell.selection()?.sessionID
          )?.directory}
          onOlder={() => shell.transcript.older()}
          onReveal={shell.transcript.reveal}
        />
      );
    },
  });
}
