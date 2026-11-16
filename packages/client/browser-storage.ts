// SPDX-License-Identifier: LGPL-3.0-only
/** Resolving the property itself can throw when browser persistence is blocked. */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
