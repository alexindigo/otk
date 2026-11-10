// SPDX-License-Identifier: LGPL-3.0-only
import type { PartKinds } from "@otk/protocol";

export function compactionLabel(
  part: PartKinds["compaction"],
  promptPending?: boolean,
): string {
  if (part.status === "failed") return "Compaction failed";
  const running = part.status === undefined
    ? promptPending
    : part.status === "running" || part.status === "queued";
  return running ? "Compacting\u2026" : "Session compacted";
}
