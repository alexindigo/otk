// SPDX-License-Identifier: LGPL-3.0-only
import type { FileDiff } from "@otk/protocol";
export function changeCounts(
  files: readonly FileDiff[],
): { additions: number; deletions: number } {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
