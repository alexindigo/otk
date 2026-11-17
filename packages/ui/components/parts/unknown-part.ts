// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import type { PartPresentation } from "../../registries/renderers.ts";
import { sourcePreview } from "./native-source-preview.ts";
import { contextualFailure } from "@otk/client";

/** The server plugin cannot know the browser's sidecar identity. Borrow the
 * injected content origin without replacing the plugin's captured target. */
export function unknownPartFailure(
  part: Part,
  origin: import("@otk/protocol").FailureTarget,
) {
  return part.kind === "external" && part.failure
    ? contextualFailure(part.failure, { target: origin })
    : undefined;
}

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
    required: activity?.tone === "error" ||
      part.kind === "external" && !!part.failure,
    copyable: content !== undefined,
    get text() {
      return content;
    },
  };
}

function previewText(part: Part) {
  const source = "source" in part ? part.source : undefined;
  if (source?.ref !== undefined) return;
  return source?.preview ??
    (part.kind === "external" ? part.data : undefined);
}
/** Availability does not encode legacy data or read a plugin Source reference. */
export function unknownPartHasPreview(part: Part): boolean {
  return previewText(part) !== undefined;
}
/** A producer that predates source references still shows its bounded data. */
export function unknownPartPreview(part: Part) {
  const source = "source" in part ? part.source : undefined;
  const text = previewText(part);
  if (text === undefined) return;
  return sourcePreview({
    preview: text,
    bytes: source?.bytes,
    truncated: !!source?.truncated,
  });
}
/** The plugin-owned reference a Source fold reads when it opens. */
export function unknownPartSource(part: Part): string | undefined {
  return "source" in part ? part.source?.ref : undefined;
}
