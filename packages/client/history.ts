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
      connection.rpc.call<HistoryEntry[]>("history.list", {}).then((entries) =>
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
  return mergeHistory(
    results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    ),
  );
}
