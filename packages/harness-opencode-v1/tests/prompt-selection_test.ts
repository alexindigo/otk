// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { DigestNativeDb } from "@otk/harness-opencode-v1";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("V1 next selection follows the latest user-role message while prompt identity stays content-proven", async () => {
  const root = await tempDir("prompt-selection-"),
    file = join(root, "native.db"),
    writer = new DatabaseSync(file);
  writer.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT)",
  );
  writer.prepare(
    "INSERT INTO session VALUES('ses_plan',NULL,'/p','p','Plan',1,2,NULL)",
  ).run();
  const user = (id: string, created: number, agent: string, variant: string) =>
    writer.prepare("INSERT INTO message VALUES(?,'ses_plan',?)").run(
      id,
      JSON.stringify({
        role: "user",
        agent,
        model: { providerID: "fake", modelID: "scripted", variant },
        time: { created },
      }),
    );
  const part = (id: string, message: string, synthetic: boolean) =>
    writer.prepare("INSERT INTO part VALUES(?,?,'ses_plan',?)").run(
      id,
      message,
      JSON.stringify({ type: "text", text: id, synthetic }),
    );
  // The user's plan prompt, then plan_exit's synthetic build handoff.
  user("msg_1", 1, "plan", "low");
  part("prt_1", "msg_1", false);
  writer.prepare("INSERT INTO message VALUES('msg_2','ses_plan',?)").run(
    JSON.stringify({
      role: "assistant",
      parentID: "msg_1",
      time: { created: 2 },
    }),
  );
  user("msg_3", 3, "build", "high");
  part("prt_3", "msg_3", true);
  writer.close();
  const native = new DigestNativeDb(file);
  try {
    assertEquals(native.transcriptMetadata("opcv1-ses_plan", []).prompt, {
      id: "msg_1",
      agent: "build",
      model: { provider: "fake", model: "scripted" },
      variant: "high",
    });
  } finally {
    native.close();
  }
});
