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
        ? `SELECT session_id AS id,
            MAX(json_extract(data, '$.time.completed')) AS terminal
          FROM message WHERE json_extract(data, '$.role') = 'assistant'
          GROUP BY session_id`
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
