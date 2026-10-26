// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import * as client from "@otk/client";
import type { Message } from "@otk/protocol";

Deno.test("timeline projects only loaded prompts in transcript order with shared queued state", () => {
  const project = (client as unknown as {
    timelinePrompts?: (messages: readonly Message[], busy?: boolean) => {
      id: string;
      time: number;
      queued: boolean;
    }[];
  }).timelinePrompts;
  assert(project, "Missing timeline projection");
  const messages: Message[] = [
    {
      id: "first",
      sessionID: "s",
      role: "user",
      time: { created: 1 },
      parts: [],
    },
    {
      id: "reply",
      sessionID: "s",
      role: "assistant",
      replyTo: "first",
      time: { created: 2 },
      agent: "build",
      model: { provider: "p", model: "m" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    },
    {
      id: "queued",
      sessionID: "s",
      role: "user",
      time: { created: 3 },
      parts: [],
    },
  ];
  const before = structuredClone(messages);
  assertEquals(
    project(messages, true).map(({ id, time, queued }) => ({
      id,
      time,
      queued,
    })),
    [
      { id: "first", time: 1, queued: false },
      { id: "queued", time: 3, queued: true },
    ],
  );
  assertEquals(project(messages).map((row) => row.queued), [false, false]);
  assertEquals(project([]), []);
  assertEquals(messages, before);
  assertEquals(
    project(messages.slice(2)).map((row) => row.id),
    ["queued"],
    "No retained prompts from an earlier page or session",
  );
});
