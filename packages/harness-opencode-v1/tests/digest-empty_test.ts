// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { DigestNativeDb } from "@otk/harness-opencode-v1";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("one bounded native projection proves empty sessions without reading headers or parts", async () => {
  const root = await tempDir("empty-scan-"),
    file = join(root, "native.db"),
    writer = new DatabaseSync(file);
  writer.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE INDEX messages_session ON message(session_id); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT)",
  );
  for (const id of ["ses_empty", "ses_full", "ses_invalid"]) {
    writer.prepare(
      "INSERT INTO session VALUES(?,NULL,'/p','p','Title',1,2,NULL)",
    ).run(id);
  }
  writer.prepare("INSERT INTO message VALUES('one','ses_full',?)").run(
    JSON.stringify({ role: "user" }),
  );
  writer.prepare(
    "INSERT INTO message VALUES('invalid','ses_invalid','not JSON')",
  ).run();
  writer.close();
  const reads: string[] = [],
    native = new DigestNativeDb(file, (operation) => reads.push(operation));
  try {
    const empty = Reflect.get(native, "emptySessions");
    assertEquals(
      typeof empty,
      "function",
      "Native empty proof must be set-based",
    );
    assertEquals(
      Reflect.apply(empty, native, [[
        "opcv1-ses_empty",
        "opcv1-ses_full",
        "opcv1-ses_invalid",
        "opcv1-ses_missing",
      ]]),
      ["opcv1-ses_empty"],
    );
    assertEquals(reads, ["empty"]);
  } finally {
    native.close();
  }
});
