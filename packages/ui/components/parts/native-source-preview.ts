// SPDX-License-Identifier: LGPL-3.0-only
/** Bounded inspection of a Source fold, independently of copy declarations. */
export function sourcePreview(
  view: { preview: string; bytes: number; truncated: boolean },
): { text: string; bytes: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(view.preview);
  let end = Math.min(encoded.length, PREVIEW_BYTES);
  // Never turn a sliced UTF-8 codepoint into a replacement character.
  while (end < encoded.length && (encoded[end] & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(encoded.subarray(0, end)),
    bytes: view.bytes,
    truncated: view.truncated || end < encoded.length,
  };
}
const PREVIEW_BYTES = 16 * 1024;
