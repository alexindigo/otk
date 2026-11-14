// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { nativeMetadata, terminalFacts, terminalToken } from "../db-hints.ts";
import { terminalSessions } from "../db-hints.ts";
import { DatabaseSync } from "node:sqlite";

Deno.test("V1 intermediate calls and scalar candidates cannot publish a proven finish", () => {
  const info = {
    id: "message",
    sessionID: "fixture",
    role: "assistant" as const,
    agent: "build",
    time: { created: 10, completed: 20 },
  };
  assertEquals(terminalToken({ ...info, finish: "tool-calls" }), 0);
  assertEquals(terminalToken({ ...info, finish: "unknown" }), 0);
  assertEquals(terminalToken({ ...info, finish: "stop" }), 20);
  assertEquals(terminalFacts({ ...info, finish: "stop" }), {
    terminal: 20,
    outcome: "succeeded",
  });
  assertEquals(
    terminalFacts({ ...info, error: { name: "APIError", data: {} } }),
    { terminal: 20, outcome: "failed" },
  );
  assertEquals(
    terminalFacts({
      ...info,
      error: { name: "MessageAbortedError", data: {} },
    }),
    { terminal: 20, outcome: "interrupted" },
  );
  assertEquals(
    terminalToken({
      ...info,
      time: { created: 10 },
      error: { name: "APIError", data: { message: "Usage limit" } },
    }),
    10,
  );
  assertEquals(
    nativeMetadata({ id: "fixture", terminal: 999 }).activity?.terminal,
    undefined,
  );
});

Deno.test("V1 later intermediate or unfinished calls cannot erase an earlier proven finish", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE session(id TEXT,parent_id TEXT,directory TEXT,project_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('fixture',NULL,'/fixture','p','Fixture',1,60,NULL)",
    );
    const insert = db.prepare("INSERT INTO message VALUES(?,'fixture',?,?)");
    insert.run(
      "final",
      10,
      JSON.stringify({
        role: "assistant",
        finish: "stop",
        time: { created: 10, completed: 20 },
      }),
    );
    insert.run(
      "tool",
      30,
      JSON.stringify({
        role: "assistant",
        finish: "tool-calls",
        time: { created: 30, completed: 40 },
      }),
    );
    insert.run(
      "unfinished",
      50,
      JSON.stringify({ role: "assistant", time: { created: 50 } }),
    );
    assertEquals(terminalSessions(db, "", 1)[0]?.activity?.terminal, 20);
    assertEquals(
      terminalSessions(db, "", 1)[0]?.activity?.outcome,
      "succeeded",
    );
    insert.run(
      "failed",
      70,
      JSON.stringify({
        role: "assistant",
        time: { created: 70 },
        error: { name: "APIError", data: { message: "Limit" } },
      }),
    );
    assertEquals(terminalSessions(db, "", 1)[0]?.activity, {
      terminal: 70,
      outcome: "failed",
    });
  } finally {
    db.close();
  }
});
