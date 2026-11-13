// SPDX-License-Identifier: LGPL-3.0-only
import type { ExternalPart, PartKinds } from "@otk/protocol";

export function metadataRecord(
  part: PartKinds["meta"] | PartKinds["step"],
): ExternalPart {
  const text = JSON.stringify(part);
  return {
    kind: "external",
    id: part.id,
    name: part.kind,
    activity: {
      kindLabel: "Record",
      layout: "row",
      category: "record",
      title: part.kind === "step"
        ? `Step ${part.phase === "start" ? "started" : "finished"}`
        : "Metadata",
      tone: "normal",
    },
    source: part.source ??
      {
        kind: part.kind,
        preview: text,
        bytes: new TextEncoder().encode(text).length,
        truncated: false,
      },
  };
}
