// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ContextMessage, Message, UserMessage } from "@otk/protocol";
import { isRealPrompt } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";
import { timelinePrompts } from "../timeline.ts";
import { createTranscript } from "../transcript.ts";
import { SidecarConnection } from "../connection.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

const prompt: UserMessage = {
  id: "prompt",
  sessionID: "acmv1-session",
  role: "user",
  time: { created: 1 },
  agent: "chosen",
  parts: [],
};
const context: ContextMessage = {
  id: "context",
  sessionID: prompt.sessionID,
  role: "context",
  time: { created: 3 },
  parts: [],
};
const answer: Message = {
  id: "answer",
  sessionID: prompt.sessionID,
  role: "assistant",
  replyTo: prompt.id,
  agent: "chosen",
  model: { provider: "acme", model: "flux" },
  time: { created: 2 },
  tokens: {
    input: null,
    output: null,
    reasoning: null,
    cache: { read: null, write: null },
  },
  cost: null,
  interrupted: false,
  parts: [],
};

Deno.test("context is visible but never a Timeline, queue or next-prompt anchor", () => {
  const owner = createTranscriptProjection();
  owner.replace([prompt, answer, context]);
  owner.busy(true);
  assertEquals(owner.state.messageIDs, ["prompt", "answer", "context"]);
  assertEquals(owner.state.replyIDs, ["prompt", "reply:prompt", "context"]);
  assertEquals(owner.state.queuedIDs.has(context.id), false);
  assertEquals(owner.state.repliesByID[context.id].pending ?? false, false);
  assertEquals(timelinePrompts(owner.messages(), true).map((item) => item.id), [
    prompt.id,
  ]);
  assertEquals(owner.messages().filter(isRealPrompt).map((item) => item.id), [
    prompt.id,
  ]);
  owner.apply({
    op: "message.upsert",
    message: { ...context, time: { created: 4 } },
  });
  assertEquals(owner.state.queuedIDs.size, 0);
});

Deno.test("reclassifying a header into context retires prompt and queue eligibility", () => {
  const owner = createTranscriptProjection();
  owner.replace([prompt, answer, {
    ...prompt,
    id: context.id,
    time: context.time,
  }]);
  owner.busy(true);
  assertEquals(owner.state.queuedIDs.has(context.id), true);
  owner.apply({ op: "message.upsert", message: context });
  assertEquals(owner.state.queuedIDs.has(context.id), false);
  assertEquals(owner.state.repliesByID[context.id].pending, false);
  assertEquals(timelinePrompts(owner.messages()).map((item) => item.id), [
    prompt.id,
  ]);
});

Deno.test("snapshot and live context never replace composer or Undo selection", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.subscribe = () => {};
  connection.supports = () => false;
  connection.rpc.call = (method) =>
    Promise.resolve(
      method === "session.messages"
        ? {
          ...fixturePage(prompt.sessionID, [prompt, context]),
          prompt: { id: prompt.id, agent: prompt.agent },
        }
        : [],
    ) as never;
  const owner = createTranscript(
    { sidecarId: "server", sessionID: prompt.sessionID },
    () => connection,
    () => undefined,
    (read) => read(),
  );
  const receive = (message: Message) =>
    owner.receive("server", {
      t: "content",
      sessionID: prompt.sessionID,
      clock: {
        epoch: owner.state.clock!.epoch,
        seq: owner.state.clock!.seq + 1,
      },
      event: { op: "message.upsert", message },
    });
  try {
    owner.temperature("screen");
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assertEquals(owner.state.latestPrompt, {
      id: prompt.id,
      agent: prompt.agent,
    });
    receive({ ...context, id: "later", time: { created: 5 } });
    assertEquals(owner.state.latestPrompt, {
      id: prompt.id,
      agent: prompt.agent,
    });
    receive({ ...context, id: prompt.id });
    assertEquals(owner.state.latestPrompt, undefined);
  } finally {
    owner.stop();
    connection.stop();
  }
});
