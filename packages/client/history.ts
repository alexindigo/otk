// SPDX-License-Identifier: LGPL-3.0-only
import { type HistoryEntry, mergeHistory } from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
export { mergeHistory, sameHistory, sameParts } from "@otk/protocol";

/** Merge reachable histories, retaining attachment ownership and partial results. */
export async function loadHistory(
  sources: { id: string; connection: SidecarConnection }[],
): Promise<HistoryEntry[]> {
  const results = await Promise.allSettled(
    sources.map(({ id, connection }) =>
      connection.rpc.call("history.list", {}).then((entries) =>
        entries.map((entry) => ({
          ...entry,
          parts: entry.parts.map((part) =>
            part.kind === "file" && part.source === "history"
              ? { ...part, sidecarID: id }
              : part
          ),
        }))
      )
    ),
  );
  const groups = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  if (!groups.length) {
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return mergeHistory(groups);
}
