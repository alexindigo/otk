// SPDX-License-Identifier: LGPL-3.0-only
/** Bound external payload previews by UTF-8 bytes, without splitting a codepoint. */
export function preview(value: unknown, limit = 65_536): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return new TextDecoder().decode(
    new TextEncoder().encode(text).subarray(0, limit),
    { stream: true },
  );
}
