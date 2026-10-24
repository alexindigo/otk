// SPDX-License-Identifier: LGPL-3.0-only
import type { PartRegistry } from "../../registries/renderers.ts";
export function registerAgentPart(parts: PartRegistry): void {
  parts.registerTyped(
    "agent",
    (props) => <span class="otk-chip">Agent: {props.part.name}</span>,
  );
}
