// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
type UnknownPart = Extract<Part, { kind: "unknown" }>;
import type { PartRegistry } from "../../registries/renderers.ts";
export function registerUnknownPart(parts: PartRegistry): void {
  parts.fallback((props) => (
    <p class="otk-muted">
      Unsupported part: {props.part.kind === "external"
        ? props.part.name
        : (props.part as UnknownPart).label || props.part.kind}
    </p>
  ));
}
