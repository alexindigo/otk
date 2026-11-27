// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import { permissionTool, toolFailure } from "@otk/client";
import type {
  PartPresentation,
  PartRegistry,
  ToolRegistry,
} from "../../registries/renderers.ts";
import ToolLine from "../ToolLine.tsx";
export function registerToolPart(
  parts: PartRegistry,
  tools: ToolRegistry,
): void {
  parts.registerTyped(
    "tool",
    (props) => {
      const call = () => permissionTool(props.part.call, props.permissions);
      return (
        <Show
          when={props.prefs.toolDetails || call().status !== "completed" ||
            !!toolFailure(call())}
        >
          <ToolLine
            call={call()}
            row={props.row}
            prefs={props.prefs}
            onOpenChild={props.onOpenChild}
            genericOutput={props.prefs.genericToolOutput}
            directory={props.directory}
            waiting={props.permissions.some((request) =>
              request.toolCall === call().callID ||
              request.sessionID === call().childSessionID
            )}
          />
        </Show>
      );
    },
    ({ call }, prefs) => {
      const required = !!toolFailure(call);
      const work = prefs.toolDetails || call.status !== "completed" || required
        ? call.time
        : undefined;
      return {
        timing: call.time,
        required,
        work,
        // Work grouping does not need to prepare tool headers until it reads run facts.
        get run(): PartPresentation["run"] {
          const p = tools.presentation(call);
          const description = "description" in call
            ? call.description
            : undefined;
          const toolName = call.tool === "external" ? call.name : call.tool;
          return {
            lane: p.category === "delegation" ? "delegation" : undefined,
            label: description || [p.verb, p.target].filter(Boolean).join(" "),
            merge: p.runs
              ? { key: `tool:${toolName}`, verb: p.verb, ...p.runs }
              : undefined,
            child: call.childSessionID,
          };
        },
      };
    },
  );
}
