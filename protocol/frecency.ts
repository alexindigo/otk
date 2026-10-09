// SPDX-License-Identifier: LGPL-3.0-only
import type { FrecencyEntry } from "./rpc.ts";
export function frecency(
  entry: FrecencyEntry | undefined,
  now = Date.now(),
): number {
  return entry
    ? entry.score / (1 + Math.max(0, now - entry.last) / 86_400_000)
    : 0;
}
