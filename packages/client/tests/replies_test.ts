// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { AssistantMessage, Message, UserMessage } from "@otk/protocol";
import { usageHeader, UsageLedger } from "@otk/protocol";
import { replyMessages, replyMetadata } from "../replies.ts";
Deno.test("reply metadata combines backend steps once, without combining unrelated or unparented replies", () => {
  const step = (id: string, replyTo?: string): AssistantMessage => ({
    id,
    sessionID: "s",
    role: "assistant",
    agent: "build",
    replyTo,
    model: { provider: "test", model: "model" },
    time: { created: Number(id), completed: 10, lastOutput: 9 },
    tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
    cost: .1,
    interrupted: false,
    parts: [{ kind: "text", id: `text-${id}`, synthetic: false, blocks: [] }],
  });
  const records = replyMetadata([
    step("1", "user"),
    { ...step("2", "user"), interrupted: true },
    step("3", "another"),
    step("4"),
    step("5"),
  ]);
  assertEquals([...records.keys()], ["2", "3", "4", "5"]);
  const usage = new UsageLedger(
    "s",
    [step("1", "user"), step("2", "user")].map(usageHeader),
  ).snapshot().turns.user;
  assertEquals(usage.tokens, {
    input: 4,
    output: 6,
    reasoning: 8,
    cache: { read: 10, write: 12 },
  });
  assertEquals(usage.cost, .2);
  assertEquals(records.get("2")?.time.created, 1);
  assertEquals(records.get("2")?.interrupted, true);
  const projected = replyMessages([
    step("1", "user"),
    step("2", "user"),
    step("3", "another"),
  ]);
  assertEquals(projected.map((message) => message.id), ["1", "3"]);
  assertEquals(projected.map((message) => message.lastID), ["2", "3"]);
  assertEquals(projected[0].parts.map((part) => part.id), ["text-1", "text-2"]);
  assertEquals(projected[0].time.created, 1);
  assertEquals(replyMessages([step("1", ""), step("2", "")]).length, 1);
  assertEquals(records.get("2")?.parts.map((part) => part.id), [
    "text-1",
    "text-2",
  ]);
});

Deno.test("reply pending projection follows current and queued user requests without reviving completed history", () => {
  const user = (id: string, created: number): UserMessage => ({
    id,
    sessionID: "s",
    role: "user",
    parts: [],
    time: { created },
  });
  const reply = (
    id: string,
    replyTo: string,
    created: number,
    completed?: number,
  ): AssistantMessage => ({
    id,
    replyTo,
    sessionID: "s",
    role: "assistant",
    agent: "build",
    model: { provider: "p", model: "m" },
    parts: [],
    time: { created, completed },
    interrupted: false,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  });
  const messages: Message[] = [
    user("old", 1),
    reply("old-reply", "old", 2, 3),
    user("current", 4),
    reply("step", "current", 5),
    user("queued", 6),
  ];
  const pending = (busy: boolean) =>
    replyMessages(messages, busy).filter((message) => message.pending).map((
      message,
    ) => message.id);
  assertEquals(pending(true), ["current", "queued"]);
  messages.push(reply("final-step", "current", 7, 8));
  assertEquals(pending(true), ["queued"]);
  messages.push(reply("queued-reply", "queued", 9, 10));
  assertEquals(pending(false), []);
  messages.push(user("newer", 11));
  assertEquals(pending(true), ["newer"]);
});
