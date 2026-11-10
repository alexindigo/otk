// SPDX-License-Identifier: LGPL-3.0-only
import "./CompactionPart.css" with { type: "text" };
import type { PartRegistry } from "../../registries/renderers.ts";
import DividerLabel from "../DividerLabel.tsx";
import { compactionLabel } from "./compaction.ts";
import { Show } from "solid-js";
import ResponseProgress from "../ResponseProgress.tsx";
export function registerCompactionPart(parts: PartRegistry): void {
  parts.registerTyped(
    "compaction",
    (props) => (
      <>
        <div class="otk-compaction-divider" role="status">
          <DividerLabel
            label={compactionLabel(props.part, props.pending)}
          />
        </div>
        <Show when={props.part.status === "running"}>
          <ResponseProgress />
        </Show>
      </>
    ),
    () => ({ frame: "transcript" }),
  );
}
