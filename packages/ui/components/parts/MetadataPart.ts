// SPDX-License-Identifier: LGPL-3.0-only
import type { PartRegistry } from "../../registries/renderers.ts";
/** Wire bookkeeping remains non-visible, as in the original message dispatch. */
export function registerMetadataParts(parts: PartRegistry): void {
  parts.registerTyped("meta", () => null);
  parts.registerTyped("step", () => null);
}
