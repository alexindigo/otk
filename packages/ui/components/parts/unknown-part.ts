// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import type { PartPresentation } from "../../registries/renderers.ts";
import { sourcePreview } from "./native-source-preview.ts";

/** Copy carries only producer-declared content; source stays inspection-only.
 * Row records flow with a reply's work; boundaries, outgoing context and
 * records outside replies stand in the transcript. */
export function unknownPartPresentation(part: Part): PartPresentation {
  const source = "source" in part ? part.source : undefined;
  const activity = part.kind === "external" ? part.activity : undefined;
  const content = part.kind === "external" && part.content
    ? source?.payload
    : undefined;
  return {
    frame: "transcript",
    ...(activity?.layout === "row" && activity.direction !== "outgoing"
      ? { work: {} }
      : {}),
    required: activity?.tone === "error",
    copyable: content !== undefined,
    get text() {
      return content;
    },
  };
}

/** A producer that predates source references still shows its bounded data. */
export function unknownPartPreview(part: Part) {
  const source = "source" in part ? part.source : undefined;
  if (source?.ref !== undefined) return;
  const text = source?.preview ??
    (part.kind === "external" ? part.data : undefined);
  if (text === undefined) return;
  return sourcePreview({
    preview: text,
    bytes: source?.bytes ?? new TextEncoder().encode(text).length,
    truncated: !!source?.truncated,
  });
}
/** The plugin-owned reference a Source fold reads when it opens. */
export function unknownPartSource(part: Part): string | undefined {
  return "source" in part ? part.source?.ref : undefined;
}
