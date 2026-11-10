// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { TranscriptReads } from "../transcript-reads.ts";
import { Messages, SCAN_ROWS } from "../messages.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";
const sid = ids.encode("ses_fixture");
function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,data TEXT);CREATE INDEX headers ON session_message(session_id,type,seq);`,
  );
  return db;
}
Deno.test("V2 native transcript facts use seq and scalar selections across page and cutoff boundaries", async () => {
  const db = fixture();
  try {
    const put = db.prepare(
      "INSERT INTO session_message VALUES (?,'ses_fixture',?,?,1,?)",
    );
    put.run(
      "msg_fork_2",
      "agent-switched",
      2,
      JSON.stringify({ agent: "plan" }),
    );
    put.run(
      "msg_fork_9",
      "user",
      9,
      JSON.stringify({ text: "private prompt" }),
    );
    put.run(
      "msg_fork_10",
      "assistant",
      10,
      JSON.stringify({
        agent: "plan",
        model: { providerID: "fake", id: "model", variant: "deep" },
        content: [{ type: "text", text: "private output" }],
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      }),
    );
    put.run(
      "msg_fork_11",
      "synthetic",
      11,
      JSON.stringify({ text: "generated context" }),
    );
    put.run(
      "msg_fork_12",
      "assistant",
      12,
      JSON.stringify({
        agent: "plan",
        model: { providerID: "fake", id: "model" },
      }),
    );
    put.run("msg_fork_13", "user", 13, JSON.stringify({ text: "reverted" }));
    const reads = new TranscriptReads(
      new Messages(() => {
        throw new Error("API must not be read");
      }),
      () => db,
    );
    const facts = await reads.facts({
      sessionID: sid,
      messages: ["msg_fork_10", "msg_fork_12"],
      cutoff: "msg_fork_13",
    }, new AbortController().signal);
    assertEquals(facts.source, "sql");
    assertEquals(facts.contexts.msg_fork_10.replyTo, "msg_fork_9");
    assertEquals(facts.contexts.msg_fork_12.replyTo, "msg_fork_9");
    assertEquals(facts.metadata.prompt, {
      id: "msg_fork_9",
      agent: "plan",
      model: { provider: "fake", model: "model" },
      variant: "deep",
    });
    assertEquals(facts.metadata.boundaries, [{
      turnID: "msg_fork_9",
      firstID: "msg_fork_10",
      lastID: "msg_fork_12",
      complete: true,
    }]);
    assertEquals(facts.cutoffOrder, 13);
    assert(!JSON.stringify(facts).includes("private"));
    const headers = reads.sqlHeaders(sid, undefined, 3)!;
    assertEquals(headers.map((r) => r.seq), [13, 12, 11]);
    assert(!JSON.stringify(headers).includes("generated context"));
  } finally {
    db.close();
  }
});
Deno.test("V2 on-demand tool labels combine split and legacy inline rows without input/output bodies", () => {
  const db = fixture();
  const observed: string[] = [];
  try {
    const split = {
      type: "tool",
      id: "split",
      name: "subagent",
      state: {
        status: "completed",
        input: { prompt: "secret" },
        metadata: { sessionID: "ses_child", title: "Inspect" },
        content: [{ type: "text", text: "private output" }],
      },
      time: { created: 1, completed: 2 },
    };
    db.prepare(
      "INSERT INTO session_part VALUES ('msg_owner','ses_fixture',0,'tool','split',?)",
    ).run(JSON.stringify(split));
    db.prepare(
      "INSERT INTO session_message VALUES ('msg_owner','ses_fixture','assistant',1,1,?)",
    ).run(
      JSON.stringify({ content: [{ ...split, id: "inline", name: "shell" }] }),
    );
    const reads = new TranscriptReads(
        new Messages(() => {
          throw new Error("no API");
        }),
        () => db,
        undefined,
        undefined,
        (operation) => observed.push(operation),
      ),
      tools = reads.tools(sid, ["msg_owner"])!;
    assertEquals(tools.map((t) => t.tool.id), [
      "msg_owner:tool:split",
      "msg_owner:tool:inline",
    ]);
    assertEquals(tools[0].child, "ses_child");
    assertEquals(observed, ["tools"]);
    assert(!JSON.stringify(tools).includes("secret"));
    assert(!JSON.stringify(tools).includes("private output"));
  } finally {
    db.close();
  }
});

Deno.test("V2 helper summaries aggregate split and inline calls without acquiring tool details", () => {
  const db = fixture(), observed: string[] = [];
  try {
    const put = db.prepare(
      "INSERT INTO session_part VALUES (?,'ses_fixture',?,'tool',?,?)",
    );
    for (let i = 0; i < 300; i++) {
      put.run(
        "msg_owner",
        i,
        `call_${i}`,
        JSON.stringify({
          name: "read",
          state: {
            status: "completed",
            input: { secret: "private input" },
            content: [{ text: "private output" }],
          },
          time: { created: i, completed: i + 1 },
        }),
      );
    }
    const inline = [{
      type: "tool",
      id: "inline",
      name: "subagent",
      state: {
        status: "running",
        metadata: { title: "Inspect", sessionID: "ses_child" },
        input: { secret: "private input" },
      },
      time: { created: 500 },
    }];
    db.prepare(
      "INSERT INTO session_message VALUES ('msg_owner','ses_fixture','assistant',1,1,?)",
    ).run(JSON.stringify({ content: inline }));
    db.prepare(
      "INSERT INTO session_message VALUES ('msg_empty','ses_fixture','user',2,2,'{}')",
    ).run();
    const reads = new TranscriptReads(
      new Messages(() => {
        throw new Error("No body API acquisition");
      }),
      () => db,
      undefined,
      undefined,
      (operation) => observed.push(operation),
    );
    reads.tools = () => {
      throw new Error("No tool-detail acquisition");
    };
    const rows = reads.helperAggregates(sid, ["msg_owner", "msg_empty"])!;
    assertEquals(rows, [{
      messageID: "msg_owner",
      toolCount: 301,
      current: { name: "subagent", title: "Inspect", startedAt: 500 },
    }]);
    assertEquals(observed, ["helpers"]);
    assert(!JSON.stringify(rows).includes("private"));
    assert(!JSON.stringify(rows).includes("ses_child"));
    assertEquals(reads.helperAggregates(sid, []), []);
    db.prepare("UPDATE session_message SET data='{}' WHERE id='msg_owner'")
      .run();
    assertEquals(reads.helperAggregates(sid, ["msg_owner"]), [{
      messageID: "msg_owner",
      toolCount: 300,
    }]);
    assertThrows(
      () => reads.helperAggregates(sid, Array(SCAN_ROWS + 1).fill("msg_owner")),
      RangeError,
    );
    db.exec("DELETE FROM session_part");
    assertEquals(reads.helperAggregates(sid, ["msg_owner"]), []);
    const unavailable = new TranscriptReads(
      new Messages(() => {
        throw new Error("No body fallback");
      }),
      () => undefined,
    );
    assertEquals(unavailable.helperAggregates(sid, ["msg_owner"]), undefined);
  } finally {
    db.close();
  }
});
