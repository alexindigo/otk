// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestPort } from "@otk/harness";
import type { OtkDb } from "@otk/store";
import { createSessionReferenceUpgrade } from "./session-ids.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Feature allowlists only. Never rewrite arbitrary IDs or scope_resource. */
function receipt(
  kind: string,
  value: unknown,
  convert: (id: string, field: string) => string,
): void {
  const field = (row: Record<string, unknown>, key: string) => {
    if (typeof row[key] === "string") {
      row[key] = convert(row[key], `request.${kind}.${key}`);
    }
  };
  const task = (row: unknown) => {
    if (object(row) && Array.isArray(row.sessions)) {
      row.sessions = row.sessions.map((id) =>
        typeof id === "string" ? convert(id, "request.task.sessions") : id
      );
    }
  };
  if (kind === "tasks" && Array.isArray(value)) {
    value.forEach(task);
    return;
  }
  if (!object(value)) return;
  if (kind === "session-created" || kind === "session-renamed") {
    field(value, "id");
    field(value, "parentID");
  }
  if (
    [
      "session-rename-intent",
      "session-boundary",
      "session-boundary-intent",
      "project-session",
    ].includes(kind)
  ) field(value, "sessionID");
  if (kind === "task") task(value);
  if (kind === "approval-policy" && Array.isArray(value.enabled)) {
    value.enabled = value.enabled.map((id) =>
      typeof id === "string"
        ? convert(id, "request.approval-policy.enabled")
        : id
    );
  }
  if (
    kind === "preferences" && object(value.shellLayout) &&
    Array.isArray(value.shellLayout.projectLocations)
  ) {
    for (const location of value.shellLayout.projectLocations) {
      if (object(location) && location.sidecarId === "local") {
        field(location, "sessionID");
      }
    }
  }
}
export function createOpencodeV2Upgrade(
  digest: DigestPort,
  codec: {
    source(value: string): string | undefined;
    target(native: string): string;
  },
  signal = new AbortController().signal,
): (store: OtkDb) => Promise<void> {
  return async (store) => {
    const db = store.connection;
    if (
      db.prepare(
        "SELECT 1 FROM session_reference_upgrades WHERE name='opencode-v2-source-ids'",
      ).get()
    ) return;
    const candidates = new Set<string>();
    const collect = (id: string) => {
      if (codec.source(id) !== undefined) candidates.add(id);
      return id;
    };
    for (
      const row of db.prepare(
        "SELECT session AS id FROM task_sessions UNION SELECT session FROM session_seen UNION SELECT session FROM session_finishes UNION SELECT session FROM permission_auto UNION SELECT session FROM permission_activity UNION SELECT owner FROM permission_activity WHERE owner IS NOT NULL UNION SELECT session FROM permission_activity_family UNION SELECT scope_session FROM request_receipts WHERE scope_session IS NOT NULL",
      ).all()
    ) collect(String(row.id));
    const requests = db.prepare(
      "SELECT principal,client_id,intent_key,scope_session,receipt_kind,receipt_json FROM request_receipts",
    ).all();
    const layout = db.prepare("SELECT value FROM prefs WHERE key='shellLayout'")
      .get();
    if (typeof layout?.value === "string") {
      try {
        receipt(
          "preferences",
          { shellLayout: JSON.parse(layout.value) },
          collect,
        );
      } catch { /* Preserve malformed preferences. */ }
    }
    for (const row of requests) {
      if (typeof row.receipt_json === "string") {
        try {
          receipt(
            String(row.receipt_kind),
            JSON.parse(row.receipt_json),
            collect,
          );
        } catch { /* Preserve malformed receipts byte-for-byte. */ }
      }
    }
    if (!candidates.size) return;
    await digest.start();
    const proof = await digest.read("opcv2.upgrade", {
      ids: [...candidates].map((id) => codec.source(id)!),
    }, { owner: "upgrade:opencode-v2", priority: "user", signal });
    signal.throwIfAborted();
    if (!proof.length) return;
    const proven = new Set(proof);
    const mapping = new Map(
      [...candidates].filter((id) => proven.has(codec.source(id)!)).map(
        (id) => [id, codec.target(codec.source(id)!)],
      ),
    );
    createSessionReferenceUpgrade((id) => mapping.get(id) ?? id, {
      name: "opencode-v2-source-ids",
      collisions: "reject",
      // The shipped client reserves "local" for this server's origin; arbitrary
      // remote IDs remain browser-owned and cannot be proven from a native ID.
      location: (location) => location.sidecarId === "local",
      references: (_store, convert) => {
        const update = db.prepare(
          "UPDATE request_receipts SET scope_session=?,receipt_json=? WHERE principal=? AND client_id=? AND intent_key=?",
        );
        for (const row of requests) {
          let json = row.receipt_json;
          if (typeof json === "string") {
            try {
              const value = JSON.parse(json), original = JSON.stringify(value);
              receipt(String(row.receipt_kind), value, convert);
              const changed = JSON.stringify(value);
              if (changed !== original) json = changed;
            } catch (error) {
              if (
                error instanceof Error && error.message.includes("collision")
              ) throw error;
            }
          }
          const scope = typeof row.scope_session === "string"
            ? convert(row.scope_session, "request.scope_session")
            : null;
          update.run(scope, json, row.principal, row.client_id, row.intent_key);
        }
      },
    })(store);
  };
}
