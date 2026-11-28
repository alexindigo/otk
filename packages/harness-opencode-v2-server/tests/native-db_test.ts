// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { V2NativeDb } from "../native-db.ts";
import { metadata } from "../metadata.ts";

Deno.test("V2 saved worktree inventory is bounded, project-scoped and schema-tolerant", () => {
  const root = Deno.makeTempDirSync({ prefix: "v2-worktrees-" }),
    file = root + "/native.db";
  const writer = new DatabaseSync(file);
  try {
    writer.exec(
      "CREATE TABLE project(id TEXT,worktree TEXT); CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE worktree(project_id TEXT,directory TEXT,strategy TEXT); INSERT INTO worktree VALUES('p','/a','git'),('p','/b',NULL),('p','/c','git'),('foreign','/d','git')",
    );
    const db = new V2NativeDb(file);
    try {
      assertEquals(db.worktrees("p", "", 2), [{
        directory: "/a",
        strategy: "git",
      }, { directory: "/b" }]);
      assertEquals(db.worktrees("p", "/b", 2), [{
        directory: "/c",
        strategy: "git",
      }]);
      assertEquals(db.worktrees("absent", "", 2), []);
    } finally {
      db.close();
    }
  } finally {
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("V2 scalar DB proves projects, groups population and reads keyed ancestry without body tables", () => {
  const root = Deno.makeTempDirSync({ prefix: "v2-scalar-" }),
    file = root + "/native.db";
  const writer = new DatabaseSync(file);
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE project(id TEXT PRIMARY KEY,worktree TEXT);INSERT INTO project VALUES('p','/repo'); CREATE TABLE session_v2(id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,title TEXT,time_archived INTEGER); CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,time_created INTEGER)",
    );
    const insert = writer.prepare(
      "INSERT INTO session_v2 VALUES(?,'p',?,?,?,?,?,NULL)",
    );
    for (let i = 0; i < 43; i++) {
      insert.run(
        `ses_${String(i).padStart(3, "0")}`,
        "/repo",
        null,
        1,
        100,
        "Root " + i,
      );
    }
    insert.run("ses_child", "/repo/tree", "ses_000", 1, 101, null);
    writer.exec(
      "INSERT INTO session VALUES('ses_000','/repo',1),('ses_001','/wrong',1)",
    );
    const reads: string[] = [],
      db = new V2NativeDb(file, (op) => reads.push(op));
    try {
      assertEquals(db.prove([{ id: "p", canonical: "/repo" }]), true);
      assertEquals(db.worktrees("p", "", 2), undefined);
      assertEquals(db.prove([{ id: "p", canonical: "/wrong" }]), false);
      assertEquals(
        db.projects("", 20).map((p) => [p.directory, p.sessionCount]),
        [["/repo", 43], ["/repo/tree", 1]],
      );
      const page = db.list(
        { directory: "/repo", parentID: null },
        undefined,
        20,
      );
      const second = db.list({ directory: "/repo", parentID: null }, {
        updated: page.at(-1)!.timeUpdated,
        id: page.at(-1)!.id.slice(6),
      }, 20);
      assertEquals(new Set([...page, ...second].map((row) => row.id)).size, 40);
      assertEquals(page[0].id, "opcv2-ses_042");
      assertEquals(
        db.identities([
          "opcv2-ses_child",
          "opcv2-ses_child",
          "opcv2-ses_absent",
        ]),
        [{
          id: "opcv2-ses_child",
          directory: "/repo/tree",
          parentID: "opcv2-ses_000",
        }],
      );
      assertEquals(db.lookup(["opcv2-ses_child"])[0].title, "Untitled session");
      assertEquals(db.facts(["opcv2-ses_child"]), [{
        id: "ses_child",
        activity: 1,
        projectID: "p",
        location: { directory: "/repo/tree" },
        parentID: "ses_000",
        time: { created: 1, updated: 101 },
      }]);
      assertEquals(Object.hasOwn(page[0], "agent"), false);
      assertEquals(db.upgrade(["ses_000", "ses_001", "ses_absent"]), [
        "ses_000",
      ]);
      assertThrows(() => db.db.prepare("DELETE FROM session_v2").run());
      assertEquals(reads.some((op) => /message|part|header/.test(op)), false);
    } finally {
      db.close();
    }
  } finally {
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("V2 DB and live metadata project the native session agent, not a default", () => {
  const root = Deno.makeTempDirSync({ prefix: "v2-session-agent-" });
  const file = root + "/native.db";
  const writer = new DatabaseSync(file);
  try {
    writer.exec(
      `CREATE TABLE project(id TEXT,worktree TEXT);
       CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,agent TEXT);
       INSERT INTO session_v2 VALUES('ses_helper','p','/repo',NULL,1,1,'junior'),('ses_unknown','p','/repo',NULL,1,1,NULL)`,
    );
    const db = new V2NativeDb(file);
    try {
      const ids = ["opcv2-ses_helper", "opcv2-ses_unknown"];
      for (const rows of [db.lookup(ids), db.facts(ids).map(metadata)]) {
        assertEquals(Reflect.get(rows[0], "agent"), "junior");
        assertEquals(Object.hasOwn(rows[1], "agent"), false);
      }
      const withAgent = { ...db.facts(ids)[1], agent: "explore" };
      assertEquals(Reflect.get(metadata(withAgent), "agent"), "explore");
    } finally {
      db.close();
    }
  } finally {
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("V2 scalar DB tolerates optional columns but rejects missing routing authority", () => {
  const root = Deno.makeTempDirSync({ prefix: "v2-schema-" }),
    file = root + "/native.db";
  const writer = new DatabaseSync(file);
  try {
    writer.exec(
      "CREATE TABLE project(id TEXT,worktree TEXT); CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER); INSERT INTO session_v2 VALUES('ses_min','p','/repo',NULL,1,2)",
    );
    const db = new V2NativeDb(file);
    try {
      assertEquals(db.lookup(["opcv2-ses_min"])[0].title, "Untitled session");
      assertEquals(db.lookup(["opcv2-ses_min"])[0].archived, false);
    } finally {
      db.close();
    }
    writer.exec(
      "ALTER TABLE session_v2 RENAME TO old_sessions; CREATE TABLE session_v2(id TEXT)",
    );
    assertThrows(
      () => new V2NativeDb(file),
      Error,
      "Incompatible native session_v2 schema",
    );
  } finally {
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("V2 historical terminal metadata retains the native quota cause and recovery without a transcript", () => {
  const root = Deno.makeTempDirSync({ prefix: "v2-terminal-failure-" }),
    file = root + "/native.db";
  const writer = new DatabaseSync(file);
  try {
    writer.exec(
      "CREATE TABLE project(id TEXT,worktree TEXT); CREATE TABLE session_v2(id TEXT,project_id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,title TEXT,time_idle INTEGER,idle_outcome TEXT); CREATE TABLE session_message(session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT); INSERT INTO session_v2 VALUES('ses_failed','p','/repo',NULL,1,100,'Failed session',100,'failed')",
    );
    writer.prepare(
      "INSERT INTO session_message VALUES('ses_failed',1,'idle',100,?)",
    ).run(JSON.stringify({
      outcome: "failed",
      time: { created: 100 },
      error: {
        type: "provider.quota",
        message: "The usage limit has been reached",
      },
    }));
    // A later failed record must not supply the reason for this terminal.
    writer.prepare(
      "INSERT INTO session_message VALUES('ses_failed',2,'idle',200,?)",
    ).run(JSON.stringify({
      outcome: "failed",
      time: { created: 200 },
      error: { type: "other", message: "Wrong terminal" },
    }));
    const db = new V2NativeDb(file);
    try {
      const scalar = db.lookup(["opcv2-ses_failed"])[0];
      const hydrated = metadata(db.facts(["opcv2-ses_failed"])[0]);
      for (const row of [scalar, hydrated]) {
        assertEquals(row.activity?.terminalOrigin, "historical");
        assertEquals(
          row.activity?.terminalFailure?.facts?.reason,
          "The usage limit has been reached",
        );
        assertEquals(
          row.activity?.terminalFailure?.facts?.recovery,
          "Check your provider quota or choose another available model, then send a new prompt.",
        );
      }
    } finally {
      db.close();
    }
  } finally {
    writer.close();
    Deno.removeSync(root, { recursive: true });
  }
});
