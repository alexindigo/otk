// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { AssistantMessage } from "@otk/protocol";
import { replyMetadata } from "../replies.ts";
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
    parts: [],
  });
  const records = replyMetadata([
    step("1", "user"),
    { ...step("2", "user"), interrupted: true },
    step("3", "another"),
    step("4"),
    step("5"),
  ]);
  assertEquals([...records.keys()], ["2", "3", "4", "5"]);
  assertEquals(records.get("2")?.tokens, {
    input: 4,
    output: 6,
    reasoning: 8,
    cache: { read: 10, write: 12 },
  });
  assertEquals(records.get("2")?.cost, .2);
  assertEquals(records.get("2")?.time.created, 1);
  assertEquals(records.get("2")?.interrupted, true);
});
