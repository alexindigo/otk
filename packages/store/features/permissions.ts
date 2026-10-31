// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb, StoreWrite } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { key, MetadataChanges } from "./metadata.ts";

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
export type PermissionChange = {
  kind: "policy";
  session: string;
  enabled: boolean;
} | {
  kind: "activity";
  sessions: string[];
  requests: {
    session: string;
    requestID: string;
    outcome: PermissionRecord["outcome"];
  }[];
};
export class PermissionStore extends MetadataChanges<PermissionChange> {
  constructor(readonly db: OtkDb, readonly now: () => number = Date.now) {
    super(db);
  }
  protected override changeKey(change: PermissionChange): string {
    return change.kind === "policy"
      ? JSON.stringify(["policy", change.session])
      : "activity";
  }
  protected override mergeChanges(
    before: PermissionChange,
    after: PermissionChange,
  ): PermissionChange {
    if (before.kind !== "activity" || after.kind !== "activity") return after;
    const requests = new Map(
      before.requests.map((
        request,
      ) => [JSON.stringify([request.session, request.requestID]), request]),
    );
    for (const request of after.requests) {
      requests.set(
        JSON.stringify([request.session, request.requestID]),
        request,
      );
    }
    return {
      kind: "activity",
      sessions: [...new Set([...before.sessions, ...after.sessions])],
      requests: [...requests.values()],
    };
  }
  enabled(): string[] {
    return this.db.connection.prepare(
      "SELECT session FROM permission_auto ORDER BY session",
    ).all().map((r) => String(r.session));
  }
  setAuto(session: string, enabled: boolean, tx?: StoreWrite): void {
    this.db.write((scope) => {
      key(session);
      if (typeof enabled !== "boolean") {
        throw new Error("Expected enabled boolean");
      }
      const result = this.db.connection.prepare(
        enabled
          ? "INSERT OR IGNORE INTO permission_auto VALUES(?)"
          : "DELETE FROM permission_auto WHERE session=?",
      ).run(session);
      if (result.changes) {
        this.changed({ kind: "policy", session, enabled }, scope);
      }
    }, tx);
  }
  confirmed(session: string, requestID: string): boolean {
    return !!this.db.connection.prepare(
      "SELECT 1 FROM permission_activity WHERE session=? AND request_id=? AND outcome='confirmed' LIMIT 1",
    ).get(key(session), key(requestID));
  }
  unconfirmed(session: string, requestID: string): boolean {
    return !!this.db.connection.prepare(
      "SELECT 1 FROM permission_activity WHERE session=? AND request_id=? AND outcome='started' LIMIT 1",
    ).get(key(session), key(requestID));
  }
  /** One scalar set read for newly encountered requests; no request bodies. */
  states(
    requests: readonly { session: string; requestID: string }[],
  ): Record<string, "started" | "confirmed" | undefined> {
    if (!requests.length) return {};
    const rows = this.db.connection.prepare(
      "SELECT a.session,a.request_id,MAX(a.outcome='confirmed') AS confirmed FROM permission_activity a JOIN json_each(?) wanted ON a.session=json_extract(wanted.value,'$.session') AND a.request_id=json_extract(wanted.value,'$.requestID') WHERE a.outcome IN ('started','confirmed') GROUP BY a.session,a.request_id",
    ).all(JSON.stringify(requests));
    return Object.fromEntries(
      rows.map((
        row,
      ) => [
        JSON.stringify([row.session, row.request_id]),
        Number(row.confirmed) ? "confirmed" : "started",
      ]),
    );
  }
  start(
    input: Omit<PermissionRecord, "id" | "time" | "outcome" | "error">,
    ancestors: string[] = [],
    tx?: StoreWrite,
  ): number {
    return this.db.write((scope) => {
      const family = [...new Set([key(input.session), ...ancestors.map(key)])];
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
      this.changed({
        kind: "activity",
        sessions: family,
        requests: [{
          session: input.session,
          requestID: input.requestID,
          outcome: "started",
        }],
      }, scope);
      return id;
    }, tx);
  }
  finish(
    id: number,
    result: { outcome: "confirmed" } | { outcome: "failed"; error: string },
    tx?: StoreWrite,
  ): void {
    this.db.write((scope) => {
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
        const request = this.db.connection.prepare(
          "SELECT session,request_id FROM permission_activity WHERE id=?",
        ).get(id)!;
        this.changed({
          kind: "activity",
          sessions,
          requests: [{
            session: String(request.session),
            requestID: String(request.request_id),
            outcome: result.outcome,
          }],
        }, scope);
      }
    }, tx);
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
