// SPDX-License-Identifier: LGPL-3.0-only
import type { PartRegistry } from "../../registries/renderers.ts";
export function registerUnknownPart(parts: PartRegistry): void {
  parts.fallback((props) => (
    <p class="otk-muted">
      Unsupported part: {props.part.kind === "external"
        ? props.part.name
        : props.part.kind === "unknown"
        ? props.part.label || props.part.kind
        : props.part.kind}
    </p>
  ));
}
