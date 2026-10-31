// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  type FeatureMigrations,
  finishesMigrations,
  frecencyMigrations,
  OtkDb,
  permissionMigrations,
  prefsMigrations,
  projectsMigrations,
  projectTemplatesMigrations,
  requestsMigrations,
  seenMigrations,
  sessionReferenceMigrations,
  tasksMigrations,
} from "@otk/store";

export const beta2Migrations: readonly FeatureMigrations[] = [
  prefsMigrations,
  frecencyMigrations,
  projectsMigrations,
  tasksMigrations,
  seenMigrations,
  finishesMigrations,
  projectTemplatesMigrations,
  permissionMigrations,
  sessionReferenceMigrations,
  requestsMigrations,
];

// Frozen from v0.1.0-beta.1 (b0d9350), not constructed using beta.2 migrations.
// Keep this historical input independent of current product schema definitions.
const beta1 = `
CREATE TABLE otk_migrations(feature TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),PRIMARY KEY(feature,version));
CREATE TABLE tasks(id TEXT PRIMARY KEY,directory TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL);
CREATE TABLE task_sessions(task TEXT NOT NULL,session TEXT NOT NULL UNIQUE,position INTEGER NOT NULL,PRIMARY KEY(task,session));
CREATE TABLE session_seen(user TEXT NOT NULL,session TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(user,session));
CREATE TABLE session_finishes(session TEXT PRIMARY KEY,time INTEGER NOT NULL);
CREATE TABLE prefs(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE frecency(directory TEXT NOT NULL,path TEXT NOT NULL,score REAL NOT NULL,last INTEGER NOT NULL,PRIMARY KEY(directory,path));
CREATE TABLE project_directories(directory TEXT PRIMARY KEY,position INTEGER NOT NULL,discovered INTEGER NOT NULL);
CREATE TABLE projects(user TEXT NOT NULL,directory TEXT NOT NULL,position INTEGER NOT NULL,added INTEGER NOT NULL DEFAULT 0,inactive INTEGER NOT NULL DEFAULT 0,last_visit INTEGER NOT NULL,inactive_at INTEGER,PRIMARY KEY(user,directory));
CREATE TABLE project_templates(position INTEGER PRIMARY KEY,template TEXT NOT NULL UNIQUE);
CREATE TABLE permission_auto(session TEXT PRIMARY KEY);
CREATE TABLE permission_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,request_id TEXT NOT NULL,request TEXT NOT NULL,reply TEXT NOT NULL CHECK(reply IN ('once','always','reject')),source TEXT NOT NULL CHECK(source IN ('manual','auto')),owner TEXT,message TEXT,time INTEGER NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('started','confirmed','failed')),error TEXT);
CREATE INDEX permission_activity_session ON permission_activity(session,id DESC);
CREATE INDEX permission_activity_request ON permission_activity(session,request_id,outcome);
CREATE TABLE permission_activity_family(session TEXT NOT NULL,activity INTEGER NOT NULL,PRIMARY KEY(session,activity));
INSERT INTO otk_migrations VALUES('prefs',1),('frecency',1),('projects',1),('tasks',1),('seen',1),('finishes',1),('project-templates',1),('project-templates',2),('permissions',1);
`;
const tables = [
  "tasks",
  "task_sessions",
  "session_seen",
  "session_finishes",
  "prefs",
  "frecency",
  "project_directories",
  "projects",
  "project_templates",
  "permission_auto",
  "permission_activity",
  "permission_activity_family",
];
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export type UserManifest = Record<string, Row[]>;
export function userSnapshot(db: Pick<OtkDb, "connection">): UserManifest {
  return Object.fromEntries(
    tables.map(
      (table) => [
        table,
        db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all() as Row[],
      ],
    ),
  );
}
export function upgradedManifest(before: UserManifest): UserManifest {
  const result = structuredClone(before);
  const qualify = (value: unknown) =>
    typeof value === "string" && value.startsWith("ses_")
      ? `opcv1-${value}`
      : value;
  for (
    const table of [
      "task_sessions",
      "session_seen",
      "session_finishes",
      "permission_auto",
      "permission_activity",
      "permission_activity_family",
    ]
  ) {
    for (const row of result[table]) {
      row.session = qualify(row.session) as string;
      if (table === "permission_activity") {
        row.owner = qualify(row.owner) as string | null;
        const request = JSON.parse(String(row.request));
        request.sessionID = qualify(request.sessionID);
        row.request = JSON.stringify(request);
      }
    }
  }
  const layout = result.prefs.find((row) => row.key === "shellLayout")!;
  const value = JSON.parse(String(layout.value));
  for (const location of value.projectLocations) {
    location.sessionID = qualify(location.sessionID);
  }
  layout.value = JSON.stringify(value);
  return result;
}

export async function beta1State(root: string, firstID = "ses_upgrade") {
  await Deno.mkdir(root, { recursive: true });
  const connection = new DatabaseSync(join(root, "otk.db"));
  try {
    connection.exec(beta1);
    connection.exec("BEGIN");
    connection.prepare(
      "INSERT INTO tasks VALUES('task-main','/project','Keep task',0),('task-empty','/project','Empty task',1)",
    ).run();
    connection.prepare(
      "INSERT INTO task_sessions VALUES('task-main',?,3),('task-main','ses_other',9)",
    ).run(firstID);
    for (const [user, time] of [["alice", 17], ["bob", 23]] as const) {
      connection.prepare("INSERT INTO session_seen VALUES(?,?,?)").run(
        user,
        firstID,
        time,
      );
      connection.prepare("INSERT INTO projects VALUES(?,'/project',0,1,1,?,?)")
        .run(user, time, time + 1);
    }
    connection.prepare("INSERT INTO session_finishes VALUES(?,31)").run(
      firstID,
    );
    connection.prepare("INSERT INTO permission_auto VALUES(?)").run(firstID);
    connection.exec(
      "INSERT INTO project_directories VALUES('/project',0,3); INSERT INTO project_templates VALUES(0,'~/Projects/{project}'); INSERT INTO frecency VALUES('/project','notes.txt',2.5,29)",
    );
    const layout = {
      leftCollapsed: true,
      rightCollapsed: true,
      projectLocations: [{
        sidecarId: "local",
        directory: "/project",
        sessionID: firstID,
      }],
      extra: { kept: true },
    };
    connection.prepare("INSERT INTO prefs VALUES('shellLayout',?,37)").run(
      JSON.stringify(layout),
    );
    connection.exec("INSERT INTO prefs VALUES('theme','\"otk-light\"',38)");
    for (let n = 1; n <= 100; n++) {
      connection.prepare(
        "INSERT INTO permission_activity VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        n,
        firstID,
        `ask-${n}`,
        JSON.stringify({
          sessionID: firstID,
          patterns: ["ses_literal_pattern"],
          detail: { kind: "other" },
        }),
        n % 2 ? "once" : "reject",
        n % 2 ? "auto" : "manual",
        "ses_other",
        "Keep outcome",
        n,
        n === 100 ? "started" : "confirmed",
        null,
      );
      connection.prepare("INSERT INTO permission_activity_family VALUES(?,?)")
        .run(firstID, n);
    }
    connection.exec("COMMIT");
    return {
      before: userSnapshot({ connection }),
      snapshot: userSnapshot,
      unchanged: [
        "tasks",
        "frecency",
        "project_directories",
        "projects",
        "project_templates",
      ],
    };
  } finally {
    connection.close();
  }
}
