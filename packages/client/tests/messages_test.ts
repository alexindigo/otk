// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Message } from "@otk/protocol";
import { emptyContent, queuedMessages, reduce } from "@otk/client";
Deno.test("queued messages exclude their answering assistant and disappear after idle", () => {
  const messages: Message[] = [{
    id: "u1",
    sessionID: "s",
    role: "user",
    time: { created: 1 },
    parts: [],
  }, {
    id: "a1",
    sessionID: "s",
    role: "assistant",
    time: { created: 2 },
    agent: "build",
    model: { provider: "p", model: "m" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    replyTo: "u1",
    parts: [],
  }, {
    id: "u2",
    sessionID: "s",
    role: "user",
    time: { created: 3 },
    parts: [],
  }];
  assertEquals([...queuedMessages(messages, true)], ["u2"]);
  assertEquals([...queuedMessages(messages, false)], []);
  const a2 = {
    ...messages[1],
    id: "a2",
    time: { created: 4 },
    replyTo: "u2",
  } as Message;
  assertEquals([...queuedMessages([...messages, a2], true)], []);
});
Deno.test("revert op owns banner state and explicit clearing", () => {
  const state = reduce(emptyContent(), {
    op: "session.revert",
    messageID: "u",
    messageCount: 2,
    files: [{ path: "a", additions: 1, deletions: 1 }],
  });
  assertEquals(state.revert?.messageCount, 2);
  assertEquals(
    reduce(state, { op: "session.revert", messageCount: 0, files: [] }).revert,
    null,
  );
});
