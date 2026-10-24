// SPDX-License-Identifier: LGPL-3.0-only
import type { PartRegistry } from "../../registries/renderers.ts";
import Reasoning from "../Reasoning.tsx";
export function registerReasoningPart(parts: PartRegistry): void {
  parts.registerTyped(
    "reasoning",
    (props) => (
      <Reasoning
        part={props.part}
        mode={props.prefs.thinking}
        conceal={props.prefs.conceal}
      />
    ),
    (part) => ({ work: part.time }),
  );
}
