// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import type { PartPresentation } from "../../registries/renderers.ts";

export function unknownPartPresentation(part: Part): PartPresentation {
  const source = "source" in part ? part.source : undefined;
  return {
    frame: "transcript",
    required: part.kind === "external" && part.activity?.tone === "error",
    copyable: source?.payload !== undefined,
    get text() {
      return source?.payload;
    },
  };
}

/** Inspection is bounded independently of whether an older producer bounded data. */
const PREVIEW_BYTES = 16 * 1024;
export function unknownPartPreview(part: Part) {
  const source = "source" in part ? part.source : undefined;
  const text = source?.preview ??
    (part.kind === "external" ? part.data : undefined);
  if (text === undefined) return;
  const encoded = new TextEncoder().encode(text);
  let end = Math.min(encoded.length, PREVIEW_BYTES);
  // Never turn a sliced UTF-8 codepoint into a replacement character.
  while (end < encoded.length && (encoded[end] & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(encoded.subarray(0, end)),
    bytes: source?.bytes ?? encoded.length,
    truncated: !!source?.truncated || end < encoded.length,
  };
}
