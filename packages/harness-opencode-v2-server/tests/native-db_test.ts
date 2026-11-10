// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { V2NativeDb } from "../native-db.ts";

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
