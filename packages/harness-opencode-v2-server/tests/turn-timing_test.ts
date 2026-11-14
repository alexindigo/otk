// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { TurnTimingAccumulator } from "@otk/harness";
import { timingEvidence } from "../turn-timing.ts";
import { TranscriptReads } from "../transcript-reads.ts";
import { Messages } from "../messages.ts";
import { mapMessage } from "../map.ts";

Deno.test("V2 terminal finish without an endpoint is not an active response", () => {
  const raw = {
    id: "m",
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "p", id: "m" },
    content: [],
    time: { created: 1000 },
    finish: "stop" as const,
  };
  const timing = new TurnTimingAccumulator();
  timing.add(timingEvidence(raw));
  assertEquals(timing.result(), {
    state: "unknown",
    start: 1000,
    terminal: true,
    reason: "missing-end",
  });
  const mapped = mapMessage(raw, "opcv2-s", { order: 1 });
  assertEquals(mapped?.role === "assistant" && mapped.terminal, true);
  const zero = mapMessage(
    { ...raw, time: { created: 0, streamed: 0, completed: 0 } },
    "opcv2-s",
    { order: 1 },
  );
  assertEquals(zero?.role === "assistant" && zero.time.completed, 0);
});

Deno.test("V2 streamed model and parallel tools share the neutral union", () => {
  const owner = new TurnTimingAccumulator();
  owner.add(timingEvidence({
    time: { created: 1000, streamed: 1500, completed: 2500 },
    content: [{
      type: "tool",
      name: "read",
      time: { created: 1300, ran: 1400, completed: 2500 },
    }, {
      type: "tool",
      name: "question",
      time: { created: 1600, completed: 2000 },
    }],
  }));
  assertEquals(owner.result(), {
    state: "known",
    start: 1000,
    end: 2500,
    workingMs: 1100,
  });
});
Deno.test("V2 scalar timing proves migration origin without trusting substituted completion", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)",
  );
  const raw = {
    type: "assistant",
    model: { providerID: "fake", id: "model" },
    time: { created: 1000, completed: 923595200 },
    content: [],
  };
  db.prepare(
    "INSERT INTO session_message VALUES('call','s','assistant',1,1000,?)",
  ).run(JSON.stringify(raw));
  db.prepare("INSERT INTO message VALUES('call','s',1000,923595200,?)").run(
    JSON.stringify({
      role: "assistant",
      providerID: "fake",
      modelID: "model",
      time: { created: 1000, completed: 1500 },
    }),
  );
  try {
    const reads = new TranscriptReads(
      new Messages(() => {
        throw new Error("No HTTP");
      }),
      () => db,
    );
    const owner = new TurnTimingAccumulator();
    owner.add(reads.sqlHeaders("opcv2-s", undefined, 10)![0].timing!);
    assertEquals(owner.result(), {
      state: "unknown",
      start: 1000,
      terminal: true,
      reason: "migration",
      explanation:
        "The real end time was lost when opencode migrated this session.",
    });
    // A resumed V2 call with its own streamed edge never borrows retained V1 clocks.
    db.prepare("UPDATE session_message SET data=?").run(
      JSON.stringify({
        ...raw,
        time: { created: 1000, streamed: 2000, completed: 2500 },
      }),
    );
    const resumed = new TurnTimingAccumulator();
    resumed.add(reads.sqlHeaders("opcv2-s", undefined, 10)![0].timing!);
    assertEquals(resumed.result(), {
      state: "known",
      start: 1000,
      end: 2500,
      workingMs: 1000,
    });
    const unfinished = { ...raw, time: { created: 1000 } };
    db.prepare("UPDATE session_message SET data=?").run(
      JSON.stringify(unfinished),
    );
    db.prepare("UPDATE message SET data=?").run(
      JSON.stringify({
        role: "assistant",
        providerID: "fake",
        modelID: "model",
        time: { created: 1000 },
      }),
    );
    const facts = reads.sqlFacts({ sessionID: "opcv2-s", messages: ["call"] })!;
    assertEquals(facts.contexts.call.terminal, true);
    const mapped = mapMessage(
      { ...unfinished, id: "call", agent: "build", type: "assistant" },
      "opcv2-s",
      facts.contexts.call,
    );
    assertEquals(mapped?.role === "assistant" && mapped.terminal, true);
    db.prepare("UPDATE session_message SET data=?").run(
      JSON.stringify({ ...unfinished, time: { created: 3000 } }),
    );
    const restarted = reads.sqlHeaders("opcv2-s", undefined, 10)![0];
    assertEquals(restarted.created, 3000);
    assertEquals(restarted.timing?.terminal, false);
  } finally {
    db.close();
  }
});
