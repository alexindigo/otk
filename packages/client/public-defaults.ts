// SPDX-License-Identifier: LGPL-3.0-only
export interface PublicDefaults {
  defaultPort: number;
}

/** Read only the public projection; absent peers never invent another default. */
export function publicDefaultsFrom(value: unknown): PublicDefaults | undefined {
  if (typeof value !== "object" || value === null) return;
  const port = (value as Record<string, unknown>).defaultPort;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0) {
    return;
  }
  return { defaultPort: port };
}
