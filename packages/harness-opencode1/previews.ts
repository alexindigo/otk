// SPDX-License-Identifier: LGPL-3.0-only
export const EXTERNAL_PREVIEW_BYTES = 65_536;
/** Bound every external payload by UTF-8 bytes, without splitting a codepoint. */
export function preview(
  value: unknown,
  limit = EXTERNAL_PREVIEW_BYTES,
): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const bytes = new TextEncoder().encode(text);
  return {
    text: new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }),
    truncated: bytes.length > limit,
  };
}
