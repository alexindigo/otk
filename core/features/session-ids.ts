// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "@otk/store";
import { isSessionID } from "@otk/protocol";

interface UpgradeOptions {
  now?: () => number;
  diagnose?: (field: string) => void;
  /** Fault-injection boundary; runs inside the upgrade transaction. */
  checkpoint?: (table: string) => void;
}

/** Application-owned beta.1 reference upgrade. The native codec is injected. */
export function createSessionReferenceUpgrade(
  legacy: (value: string) => string,
  options: UpgradeOptions = {},
): (store: OtkDb) => void {
  const diagnose = options.diagnose ??
    ((field) =>
      console.warn(`Session ID upgrade: retained unconvertible ${field}`));
  return (store) =>
    store.transaction(() => {
      const db = store.connection;
      const name = "opencode-v1-session-ids";
      if (
        db.prepare(
          "SELECT version FROM session_reference_upgrades WHERE name=?",
        ).get(name)
      ) return;
      const conversions = new Map<string, string>();
      const convert = (value: string, field: string): string => {
        let next = conversions.get(value);
        if (next === undefined) {
          next = legacy(value);
          conversions.set(value, next);
        }
        if (!isSessionID(next)) diagnose(field);
        return next;
      };
      const json = (
        raw: string,
        field: string,
        change: (value: Record<string, unknown>) => boolean,
      ): string => {
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          diagnose(field);
          return raw;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          diagnose(field);
          return raw;
        }
        return change(value as Record<string, unknown>)
          ? JSON.stringify(value)
          : raw;
      };
      // Stage validated memberships first: UNIQUE must never choose a surviving task.
      db.exec(
        "CREATE TABLE session_ref_members (task TEXT NOT NULL, session TEXT PRIMARY KEY, position INTEGER NOT NULL)",
      );
      const member = db.prepare(
        "INSERT INTO session_ref_members VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET position=MIN(position,excluded.position)",
      );
      const owner = db.prepare(
        "SELECT task FROM session_ref_members WHERE session=?",
      );
      for (const row of db.prepare("SELECT * FROM task_sessions").all()) {
        const id = convert(String(row.session), "task_sessions.session");
        const previous = owner.get(id);
        if (previous && previous.task !== row.task) {
          throw new Error(
            `Conflicting task membership for ${id}: ${previous.task} and ${row.task}`,
          );
        }
        member.run(String(row.task), id, row.position);
      }
      db.exec(
        "DELETE FROM task_sessions; INSERT INTO task_sessions SELECT task,session,position FROM session_ref_members; DROP TABLE session_ref_members",
      );
      options.checkpoint?.("task_sessions");

      db.exec(
        "CREATE TABLE session_ref_seen (user TEXT NOT NULL, session TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY(user,session))",
      );
      const seen = db.prepare(
        "INSERT INTO session_ref_seen VALUES(?,?,?) ON CONFLICT(user,session) DO UPDATE SET time=MAX(time,excluded.time)",
      );
      for (const row of db.prepare("SELECT * FROM session_seen").all()) {
        seen.run(
          String(row.user),
          convert(String(row.session), "session_seen.session"),
          row.time,
        );
      }
      db.exec(
        "DELETE FROM session_seen; INSERT INTO session_seen SELECT * FROM session_ref_seen; DROP TABLE session_ref_seen",
      );
      options.checkpoint?.("session_seen");

      db.exec(
        "CREATE TABLE session_ref_finishes (session TEXT PRIMARY KEY, time INTEGER NOT NULL)",
      );
      const finishes = db.prepare(
        "INSERT INTO session_ref_finishes VALUES(?,?) ON CONFLICT(session) DO UPDATE SET time=MAX(time,excluded.time)",
      );
      for (const row of db.prepare("SELECT * FROM session_finishes").all()) {
        finishes.run(
          convert(String(row.session), "session_finishes.session"),
          row.time,
        );
      }
      db.exec(
        "DELETE FROM session_finishes; INSERT INTO session_finishes SELECT * FROM session_ref_finishes; DROP TABLE session_ref_finishes",
      );
      options.checkpoint?.("session_finishes");

      db.exec("CREATE TABLE session_ref_auto (session TEXT PRIMARY KEY)");
      const auto = db.prepare(
        "INSERT INTO session_ref_auto VALUES(?) ON CONFLICT DO NOTHING",
      );
      for (
        const row of db.prepare("SELECT session FROM permission_auto").all()
      ) auto.run(convert(String(row.session), "permission_auto.session"));
      db.exec(
        "DELETE FROM permission_auto; INSERT INTO permission_auto SELECT * FROM session_ref_auto; DROP TABLE session_ref_auto",
      );
      options.checkpoint?.("permission_auto");

      const activity = db.prepare(
        "UPDATE permission_activity SET session=?,owner=?,request=? WHERE id=?",
      );
      for (
        const row of db.prepare(
          "SELECT id,session,owner,request FROM permission_activity",
        ).all()
      ) {
        const field = `permission_activity.request[${row.id}]`;
        const request = json(String(row.request), field, (value) => {
          if (typeof value.sessionID !== "string") {
            diagnose(`${field}.sessionID`);
            return false;
          }
          const next = convert(value.sessionID, `${field}.sessionID`);
          if (next === value.sessionID) return false;
          value.sessionID = next;
          return true;
        });
        activity.run(
          convert(String(row.session), "permission_activity.session"),
          row.owner === null
            ? null
            : convert(String(row.owner), "permission_activity.owner"),
          request,
          row.id,
        );
      }
      options.checkpoint?.("permission_activity");

      db.exec(
        "CREATE TABLE session_ref_family (session TEXT NOT NULL, activity INTEGER NOT NULL, PRIMARY KEY(session,activity))",
      );
      const family = db.prepare(
        "INSERT INTO session_ref_family VALUES(?,?) ON CONFLICT DO NOTHING",
      );
      for (
        const row of db.prepare("SELECT * FROM permission_activity_family")
          .all()
      ) {
        family.run(
          convert(String(row.session), "permission_activity_family.session"),
          row.activity,
        );
      }
      db.exec(
        "DELETE FROM permission_activity_family; INSERT INTO permission_activity_family SELECT * FROM session_ref_family; DROP TABLE session_ref_family",
      );
      options.checkpoint?.("permission_activity_family");

      const layout = db.prepare(
        "SELECT value FROM prefs WHERE key='shellLayout'",
      ).get();
      if (layout) {
        const value = json(
          String(layout.value),
          "prefs.shellLayout",
          (value) => {
            if (value.projectLocations === undefined) return false;
            if (!Array.isArray(value.projectLocations)) {
              diagnose("prefs.shellLayout.projectLocations");
              return false;
            }
            let changed = false;
            for (const [i, location] of value.projectLocations.entries()) {
              const field =
                `prefs.shellLayout.projectLocations[${i}].sessionID`;
              if (
                !location || typeof location !== "object" ||
                typeof location.sessionID !== "string"
              ) {
                diagnose(field);
                continue;
              }
              const next = convert(location.sessionID, field);
              if (next !== location.sessionID) {
                location.sessionID = next;
                changed = true;
              }
            }
            return changed;
          },
        );
        if (value !== layout.value) {
          db.prepare("UPDATE prefs SET value=? WHERE key='shellLayout'").run(
            value,
          );
        }
      }
      options.checkpoint?.("prefs");
      options.checkpoint?.("marker");
      db.prepare("INSERT INTO session_reference_upgrades VALUES(?,1,?)").run(
        name,
        (options.now ?? Date.now)(),
      );
    });
}
