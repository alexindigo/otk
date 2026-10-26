// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo } from "solid-js";
import { timelinePrompts } from "@otk/client";
import { useCommandPorts } from "../keyboard/context.tsx";
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
      const shell = useShellPorts(), { commands } = useCommandPorts();
      const { parts } = useUiRegistries();
      const prompts = createMemo(() =>
        timelinePrompts(
          shell.transcript.messages(),
          shell.entries().some((entry) =>
            entry.sidecarId === shell.selection()?.sidecarId &&
            entry.id === shell.selection()?.sessionID && entry.status !== "idle"
          ),
        ).filter((prompt) =>
          messageFrames({ ...prompt, role: "user" }, (part) =>
            parts.presentation(part, shell.toggles.state.prefs)).prompt
        )
      );
      return (
        <Timeline
          session={shell.selection()}
          prompts={prompts()}
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
          onReveal={(messageID) =>
            commands.run("transcript.reveal", { messageID })}
        />
      );
    },
  });
}
