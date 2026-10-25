// SPDX-License-Identifier: LGPL-3.0-only
import "./CompactionPart.css" with { type: "text" };
import type { PartRegistry } from "../../registries/renderers.ts";
import DividerLabel from "../DividerLabel.tsx";
export function registerCompactionPart(parts: PartRegistry): void {
  parts.registerTyped(
    "compaction",
    (props) => (
      <div class="otk-compaction-divider" role="status">
        <DividerLabel
          label={props.pending ? "Compacting…" : "Session compacted"}
        />
      </div>
    ),
    () => ({ frame: "transcript" }),
  );
}
