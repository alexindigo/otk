// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
type ReasoningPart = Extract<Part, { kind: "reasoning" }>;
import type { PartRegistry } from "../../registries/renderers.ts";
import Reasoning from "../Reasoning.tsx";
export function registerReasoningPart(parts: PartRegistry): void {
  parts.registerTyped(
    "reasoning",
    (props) => (
      <Reasoning
        part={props.part as ReasoningPart}
        mode={props.prefs.thinking}
      />
    ),
    (part) => ({ work: part.time }),
  );
}
