// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { type OtkDb, Seen } from "@otk/store";
import { BootstrapDb, opencodeV1SessionID } from "@otk/harness-opencode-v1";

function* terminals(
  path: string,
  kind: "opencode-v1" | "opencode-v2-server",
): Generator<{ id: unknown; terminal: unknown }> {
  if (kind === "opencode-v1") {
    // The adapter owns terminal qualification and historical retention. A
    // fixture must not maintain a second, diverging native selection rule.
    const native = new BootstrapDb(path, (_level, message, error) => {
      throw error ?? new Error(message);
    });
    try {
      let after = "";
      for (;;) {
        const rows = native.terminals(after, 200);
        if (!rows.length) return;
        for (const row of rows) {
          yield {
            id: opencodeV1SessionID.decode(row.id),
            terminal: row.activity?.terminal,
          };
        }
        after = rows.at(-1)!.id;
      }
    } finally {
      native.close();
    }
  } else {
    const native = new DatabaseSync(path, { readOnly: true });
    try {
      yield* native.prepare(
        `SELECT id, time_idle AS terminal FROM session_v2
          WHERE idle_outcome IN ('succeeded', 'failed', 'interrupted')`,
      ).all() as { id: unknown; terminal: unknown }[];
    } finally {
      native.close();
    }
  }
}

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
  const rows = [...terminals(path, kind)];
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
}
