// SPDX-License-Identifier: LGPL-3.0-only
import { type OtkDb, Seen } from "@otk/store";
import { BootstrapDb, opencodeV1SessionID } from "@otk/harness-opencode-v1";
import {
  opencodeV2SessionID,
  V2NativeDb,
} from "@otk/harness-opencode-v2-server";

function* terminals(
  path: string,
  kind: "opencode-v1" | "opencode-v2-server",
): Generator<{ id: unknown; terminal: unknown }> {
  // Native readers own terminal qualification and historical retention. This
  // fixture only paginates their inventory and maps exact manifest identities.
  const native = kind === "opencode-v1"
    ? new BootstrapDb(path, (_level, message, error) => {
      throw error ?? new Error(message);
    })
    : new V2NativeDb(path);
  const sessionIDs = kind === "opencode-v1"
    ? opencodeV1SessionID
    : opencodeV2SessionID;
  try {
    let after = "";
    for (;;) {
      const rows = native.terminals(after, 200);
      if (!rows.length) return;
      for (const row of rows) {
        yield {
          id: sessionIDs.decode(row.id),
          terminal: row.activity?.terminal,
        };
      }
      after = rows.at(-1)!.id;
    }
  } finally {
    native.close();
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
