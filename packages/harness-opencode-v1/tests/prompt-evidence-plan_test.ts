// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { promptEvidenceSQL } from "../records.ts";

Deno.test("prompt evidence probes one message's parts, not every part of its session", () => {
  const db = new DatabaseSync(":memory:");
  try {
    // Stock 1.19.3 message/part keys and indexes.
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX message_session_time_created_id_idx ON message (session_id,time_created,id);
      CREATE INDEX part_message_id_id_idx ON part (message_id,id);
      CREATE INDEX part_session_idx ON part (session_id);
    `);
    const message = db.prepare("INSERT INTO message VALUES (?,?,?,?)");
    const part = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
    let prompts = 0;
    for (let i = 0; i < 400; i++) {
      const id = `msg_${String(i).padStart(4, "0")}`, user = i % 2 === 0;
      message.run(
        id,
        "ses",
        i,
        JSON.stringify({ role: user ? "user" : "assistant" }),
      );
      const synthetic = user && i % 10 === 0;
      if (user && !synthetic) prompts++;
      for (let j = 0; j < 5; j++) {
        part.run(
          `${id}_${j}`,
          id,
          "ses",
          i,
          JSON.stringify(
            user
              ? {
                type: "text",
                text: "x",
                ...(synthetic ? { synthetic: true } : {}),
              }
              : { type: "tool", output: "y".repeat(200) },
          ),
        );
      }
    }
    const sql =
      `SELECT count(*) AS n FROM message m WHERE m.session_id=? AND json_extract(m.data,'$.role')='user' AND ${promptEvidenceSQL()}`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("ses").map((
      row,
    ) => String(row.detail)).join("\n");
    assert(
      /SEARCH prompt_part (?:EXISTS )?USING INDEX part_message_id_id_idx \(message_id=\?\)/
        .test(plan),
      plan,
    );
    assert(!/part_session_idx|SCAN prompt_part/.test(plan), plan);
    assertEquals(Number(db.prepare(sql).get("ses")!.n), prompts);
  } finally {
    db.close();
  }
});
