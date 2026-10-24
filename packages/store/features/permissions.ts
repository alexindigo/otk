// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { Changes } from "../changes.ts";
import { key } from "./metadata.ts";

export const permissionMigrations: FeatureMigrations = {
  feature: "permissions",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/permissions/001.sql", import.meta.url),
  }],
};
/** Scalars/JSON are injected by the application; storage knows no wire schema. */
export interface PermissionRecord {
  id: number;
  session: string;
  requestID: string;
  request: string;
  reply: "once" | "always" | "reject";
  source: "manual" | "auto";
  owner?: string;
  message?: string;
  time: number;
  outcome: "started" | "confirmed" | "failed";
  error?: string;
}
export type PermissionChange = { kind: "policy" } | {
  kind: "activity";
  sessions: string[];
};
export class PermissionStore extends Changes<PermissionChange> {
  constructor(readonly db: OtkDb, readonly now: () => number = Date.now) {
    super(db);
  }
  enabled(): string[] {
    return this.db.connection.prepare(
      "SELECT session FROM permission_auto ORDER BY session",
    ).all().map((r) => String(r.session));
  }
  setAuto(session: string, enabled: boolean): void {
    key(session);
    if (typeof enabled !== "boolean") {
      throw new Error("Expected enabled boolean");
    }
    const result = this.db.connection.prepare(
      enabled
        ? "INSERT OR IGNORE INTO permission_auto VALUES(?)"
        : "DELETE FROM permission_auto WHERE session=?",
    ).run(session);
    if (result.changes) this.changed({ kind: "policy" });
  }
  confirmed(session: string, requestID: string): boolean {
    return !!this.db.connection.prepare(
      "SELECT 1 FROM permission_activity WHERE session=? AND request_id=? AND outcome='confirmed' LIMIT 1",
    ).get(key(session), key(requestID));
  }
  start(
    input: Omit<PermissionRecord, "id" | "time" | "outcome" | "error">,
    ancestors: string[] = [],
  ): number {
    const family = [...new Set([key(input.session), ...ancestors.map(key)])];
    const id = this.db.transaction(() => {
      const result = this.db.connection.prepare(
        "INSERT INTO permission_activity(session,request_id,request,reply,source,owner,message,time,outcome) VALUES(?,?,?,?,?,?,?,?,'started')",
      ).run(
        key(input.session),
        key(input.requestID),
        input.request,
        input.reply,
        input.source,
        input.owner ?? null,
        input.message ?? null,
        this.now(),
      );
      const id = Number(result.lastInsertRowid);
      const link = this.db.connection.prepare(
        "INSERT INTO permission_activity_family(session,activity) VALUES(?,?)",
      );
      for (const session of family) link.run(session, id);
      return id;
    });
    this.changed({ kind: "activity", sessions: family });
    return id;
  }
  finish(
    id: number,
    result: { outcome: "confirmed" } | { outcome: "failed"; error: string },
  ): void {
    const update = this.db.connection.prepare(
      "UPDATE permission_activity SET outcome=?,error=? WHERE id=? AND outcome='started'",
    ).run(
      result.outcome,
      result.outcome === "failed" ? result.error : null,
      id,
    );
    if (update.changes) {
      const sessions = this.db.connection.prepare(
        "SELECT session FROM permission_activity_family WHERE activity=? ORDER BY session",
      ).all(id).map((row) => String(row.session));
      this.changed({ kind: "activity", sessions });
    }
  }
  list(
    sessions: string[],
    before = Number.MAX_SAFE_INTEGER,
  ): PermissionRecord[] {
    for (const session of sessions) key(session);
    return this.db.connection.prepare(
      "SELECT a.* FROM permission_activity a WHERE a.id IN (SELECT activity FROM permission_activity_family WHERE session IN (SELECT value FROM json_each(?))) AND a.id<? ORDER BY a.id DESC LIMIT 101",
    ).all(JSON.stringify(sessions), before).map((r) => ({
      id: Number(r.id),
      session: String(r.session),
      requestID: String(r.request_id),
      request: String(r.request),
      reply: r.reply as PermissionRecord["reply"],
      source: r.source as PermissionRecord["source"],
      owner: r.owner === null ? undefined : String(r.owner),
      message: r.message === null ? undefined : String(r.message),
      time: Number(r.time),
      outcome: r.outcome as PermissionRecord["outcome"],
      error: r.error === null ? undefined : String(r.error),
    }));
  }
}
