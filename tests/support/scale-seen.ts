// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { type OtkDb, Seen } from "@otk/store";

/** Arrange an existing OTK user's viewed seed history before application start.
 * Only exact native terminals for manifest identities are acknowledged. New
 * sessions and later terminals remain unseen; native viewed state is never read.
 */
export function seedScaleSeen(
  store: OtkDb,
  path: string,
  kind: "opencode-v1" | "opencode-v2-server",
  sessions: readonly { id: string; nativeID: string }[],
) {
  const native = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = native.prepare(
      kind === "opencode-v1"
        ? `WITH latest AS (
            SELECT session_id AS id, data, time_created,
              row_number() OVER (
                PARTITION BY session_id ORDER BY time_created DESC, id DESC
              ) AS rank
            FROM message
            WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant'
          ) SELECT id, CASE
            WHEN json_extract(data, '$.error') IS NOT NULL THEN
              coalesce(json_extract(data, '$.time.completed'), time_created)
            WHEN json_extract(data, '$.finish') IS NOT NULL
              AND json_extract(data, '$.finish') NOT IN ('tool-calls', 'unknown')
              THEN json_extract(data, '$.time.completed')
          END AS terminal FROM latest WHERE rank = 1`
        : `SELECT id, time_idle AS terminal FROM session_v2
          WHERE idle_outcome IN ('succeeded', 'failed', 'interrupted')`,
    ).all();
    const ids = new Map(
        sessions.map((session) => [session.nativeID, session.id]),
      ),
      seen = new Seen(store);
    store.write((tx) => {
      for (const row of rows) {
        const id = ids.get(String(row.id)), terminal = Number(row.terminal);
        if (id && terminal > 0) seen.acknowledge("local", id, terminal, tx);
      }
    });
  } finally {
    native.close();
  }
}
