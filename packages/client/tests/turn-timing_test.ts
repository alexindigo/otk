// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { AssistantMessage } from "@otk/protocol";
import { projectReplies } from "../transcript-projection.ts";
import { reduceMessage } from "../reduce.ts";
import { isAssistantTerminal, usageHeader } from "@otk/protocol";
const call = (id: string, created: number): AssistantMessage => ({
  id,
  sessionID: "tstv1-timing",
  role: "assistant",
  replyTo: "prompt",
  agent: "agent",
  model: { provider: "p", model: "m" },
  time: { created, completed: created + 500 },
  tokens: {
    input: null,
    output: null,
    reasoning: null,
    cache: { read: null, write: null },
  },
  cost: null,
  interrupted: false,
  parts: [],
});
Deno.test("loaded-page reply projection never manufactures a full-turn clock span", () => {
  const first = call("first", 1000), last = call("last", 1000 + 10 * 86400000);
  const [reply] = projectReplies([first, last]);
  assertEquals(reply.firstID, first.id);
  assertEquals(reply.lastID, last.id);
  assertEquals(reply.message.time, last.time);
});
Deno.test("terminal assistant without an endpoint is not a pending turn", () => {
  const message = call("interrupted", 1000);
  message.time = { created: 1000 };
  message.terminal = true;
  message.interrupted = true;
  const [reply] = projectReplies([message], true);
  assertEquals(
    reply.message.role === "assistant" && reply.message.terminal,
    true,
  );
  assertEquals(usageHeader(message).completed, true);
  const stale = { ...message, terminal: undefined, interrupted: false };
  assertEquals(
    reduceMessage(message, { op: "message.upsert", message: stale }),
    message,
  );
  const restarted = reduceMessage(message, {
    op: "message.upsert",
    message: stale,
    restart: true,
  })!;
  assertEquals(isAssistantTerminal(restarted), false);
});
