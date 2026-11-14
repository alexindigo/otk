// SPDX-License-Identifier: LGPL-3.0-only
import type { NativeSource } from "@otk/protocol";

/** Native objects have no wire spelling after SDK decoding. Stable key order
 * makes snapshot and event projections inspect identically; arrays stay ordered. */
function stable(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
        : value,
  ) ?? "";
}
export function nativeSource(
  kind: string,
  value: unknown,
  payload?: string,
): NativeSource {
  const source = stable(value),
    bytes = new TextEncoder().encode(source),
    limit = 16384;
  return {
    kind: `opencode-v2/${kind}`,
    preview: new TextDecoder().decode(bytes.subarray(0, limit), {
      stream: bytes.length > limit,
    }),
    bytes: bytes.length,
    truncated: bytes.length > limit,
    payload: payload ?? source,
  };
}
