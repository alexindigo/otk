// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { entityFacts } from "../entity-facts.ts";
import type { ToolCall } from "@otk/protocol";
import { createEntityStateStore, lamp } from "../entity-state.ts";

Deno.test("reply facts use canonical work, never session age or helper endpoints", () => {
  const sources = {
    session: () => ({ title: "18 day session" }),
  };
  const facts = entityFacts({
    sessionID: "s",
    turnID: "turn",
    timing: { state: "known", start: 100, end: 9000, workingMs: 2000 },
    outcomeTime: { state: "known", at: 9000, source: "completed" },
  }, sources);
  assertEquals(facts.reply?.working, {
    known: true,
    value: 2000,
    final: true,
    active: false,
  });
  assertEquals(facts.reply?.completed, {
    known: true,
    value: 9000,
    final: true,
    active: false,
  });
  assertEquals(facts.session.title, "18 day session");
});
Deno.test("active and migrated reply facts never inherit a finished clock", () => {
  const sources = { session: () => ({ title: "Session" }) };
  const active = entityFacts({
    sessionID: "s",
    turnID: "turn",
    timing: { state: "active", start: 100, workingMs: 2000 },
  }, sources);
  assertEquals(active.reply?.completed.known, false);
  assertEquals(active.reply?.working.final, false);
  const migrated = entityFacts({
    sessionID: "s",
    turnID: "turn",
    timing: {
      state: "unknown",
      start: 100,
      terminal: true,
      reason: "migration",
    },
  }, sources);
  assertEquals(migrated.reply?.working.known, false);
  assertEquals(migrated.reply?.completed.known, false);
});
Deno.test("historical reply facts borrow the current entity replica across reconnect", () => {
  let status: "none" | "working" = "none";
  const entities = createEntityStateStore({
    read: () => ({
      "session:s": {
        kind: "session",
        id: "s",
        state: status,
        previous: "none",
        counts: {
          working: Number(status === "working"),
          blocked: 0,
          finished: 0,
          unseen: 0,
        },
      },
    }),
  });
  const source = { session: () => ({ title: "Session" }), entities };
  const identity = {
    sessionID: "s",
    turnID: "historical",
    timing: { state: "known" as const, start: 100, end: 200, workingMs: 100 },
    outcomeTime: {
      state: "known" as const,
      at: 200,
      source: "completed" as const,
    },
  };
  const state = () =>
    lamp(entityFacts(identity, source).session.entities!, "session:s", {
      now: 0,
    });
  assertEquals(state(), "none");
  status = "working";
  assertEquals(state(), "working");
  status = "none";
  assertEquals(entityFacts(identity, source).reply?.completed.value, 200);
  assertEquals(state(), "none");
  entities.stop();
});

Deno.test("failure completion survives unavailable working time in entity facts", () => {
  const facts = entityFacts({
    turnID: "failed",
    outcomeTime: { state: "known", at: 1500, source: "completed" },
  });
  assertEquals(facts.reply?.working.known, false);
  assertEquals(facts.reply?.completed, {
    known: true,
    value: 1500,
    final: true,
    active: false,
  });
});

Deno.test("tool facts retain their own scope and never certify an unfinished endpoint", () => {
  const tool: ToolCall = {
    tool: "bash",
    callID: "call",
    command: "echo done",
    output: "done",
    status: "running",
    time: { start: 100, end: 2100 },
  };
  const active = entityFacts({ sessionID: "s", tool });
  assertEquals(active.reply, undefined);
  assertEquals(active.tool?.completed.known, false);
  tool.status = "completed";
  const complete = entityFacts({ sessionID: "s", tool });
  assertEquals(complete.tool?.working.value, 2000);
  assertEquals(complete.tool?.completed.value, 2100);
  assertEquals(entityFacts({ sessionID: "s" }).reply, undefined);
});
