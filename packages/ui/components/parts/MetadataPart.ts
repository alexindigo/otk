// SPDX-License-Identifier: LGPL-3.0-only
import type { PartRegistry } from "../../registries/renderers.ts";
import { UnknownPart } from "./UnknownPart.tsx";
import { metadataRecord } from "./metadata-record.ts";
/** Legacy bookkeeping uses the same neutral record disclosure as other activity. */
export function registerMetadataParts(parts: PartRegistry): void {
  for (const kind of ["meta", "step"] as const) {
    parts.registerTyped(kind, (props) =>
      UnknownPart({
        ...props,
        get part() {
          return metadataRecord(props.part);
        },
        get prefs() {
          return props.prefs;
        },
      }), () => ({ work: {} }));
  }
}
