// SPDX-License-Identifier: LGPL-3.0-only
import "./CompactionPart.css" with { type: "text" };
import type { PartRegistry } from "../../registries/renderers.ts";
export function registerCompactionPart(parts: PartRegistry): void {
  parts.registerTyped(
    "compaction",
    () => <div class="otk-compaction-divider">Compaction</div>,
  );
}
