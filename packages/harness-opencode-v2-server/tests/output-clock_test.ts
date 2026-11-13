// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ContentOp } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import { mapMessage } from "../map.ts";
import { cfg } from "../../../tests/support/config.ts";
import { isAssistantTerminal } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import type { NativeMessage } from "../messages.ts";
import { factsFrom, scalarMessage } from "../transcript-reads.ts";

Deno.test("V2 terminal page without an end releases streams and requires a fresh start to reopen", async () => {
  const raw: NativeMessage = {
    id: "msg_closed",
    type: "assistant",
    agent: "build",
    model: { providerID: "fake", id: "scripted" },
    content: [{ type: "text", text: "Interrupted body." }],
    time: { created: 1 },
    error: { type: "aborted", message: "Interrupted" },
  };
  const updates: ContentOp[] = [];
  const api = {
    session: {
      get: () =>
        Promise.resolve({
          id: "ses_clock",
          projectID: "p",
          location: { directory: "/p" },
          time: { created: 1, updated: 2 },
        }),
    },
    message: { list: () => Promise.resolve({ data: [raw], cursor: {} }) },
  };
  const client = {
    service: { version: "2.2.6" },
    read: <T>(run: (api: unknown) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const transcript = new Transcript({
    client: () => client,
    policy: cfg().messages,
    facts: () => Promise.resolve(factsFrom([scalarMessage(raw, 1)], [raw.id])),
    content: (_id, op) => updates.push(op),
    diagnostic() {},
    invalidated() {},
  });
  const id = "opcv2-ses_clock";
  transcript.subscriptions(id, 1);
  try {
    const page = await transcript.page(id);
    assertEquals(isAssistantTerminal(page.items[0]), true);
    const text = page.items[0].parts.find((part) => part.kind === "text");
    assert(text?.kind === "text");
    assertEquals(text.stream, undefined);
    const count = updates.length,
      data = {
        sessionID: "ses_clock",
        assistantMessageID: raw.id,
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
      };
    await transcript.event({
      type: "session.step.started",
      created: 3,
      data: { ...data, started: 1 },
    });
    assertEquals(updates.length, count);
    await transcript.event({
      type: "session.step.started",
      created: 4,
      data: { ...data, started: 4 },
    });
    const last = updates.filter((op) => op.op === "message.upsert").at(-1)!;
    assert(last.op === "message.upsert");
    assertEquals(last.restart, true);
    assertEquals(isAssistantTerminal(last.message), false);
  } finally {
    await transcript.stop();
  }
});

Deno.test("V2 terminal event without a clock does not manufacture an observation-time endpoint", async () => {
  const updates: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No native read expected");
    },
    policy: cfg().messages,
    content: (_id, op) => updates.push(op),
    diagnostic() {},
    invalidated() {},
  });
  const id = "opcv2-ses_clock",
    data = {
      sessionID: "ses_clock",
      assistantMessageID: "msg_clockless",
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
    };
  transcript.subscriptions(id, 1);
  try {
    await transcript.event({ type: "session.step.started", created: 1, data });
    await transcript.event({
      type: "session.step.failed",
      data: { ...data, error: { type: "aborted", message: "Interrupted" } },
    });
    const final = updates.filter((op) => op.op === "message.upsert").at(-1)!;
    assert(final.op === "message.upsert" && final.message.role === "assistant");
    assertEquals(final.message.time.completed, undefined);
    assertEquals(final.message.terminal, true);
    await transcript.event({
      type: "session.step.started",
      created: 3,
      data: { ...data, started: 3 },
    });
    const restarted = updates.filter((op) => op.op === "message.upsert").at(
      -1,
    )!;
    assert(restarted.op === "message.upsert");
    assertEquals(restarted.restart, true);
  } finally {
    await transcript.stop();
  }
});

Deno.test("V2 live and reloaded output clocks share the native streamed edge, not terminal bookkeeping", async () => {
  const updates: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No native read expected");
    },
    policy: cfg().messages,
    content: (_id, op) => {
      updates.push(op);
    },
    diagnostic() {},
    invalidated() {},
  });
  const id = "opcv2-ses_clock", messageID = "msg_clock";
  const data = { sessionID: "ses_clock", assistantMessageID: messageID };
  transcript.subscriptions(id, 1);
  try {
    await transcript.event({
      type: "session.step.started",
      created: 1,
      data: {
        ...data,
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
      },
    });
    await transcript.event({ type: "session.step.streamed", created: 3, data });
    await transcript.event({ type: "session.step.ended", created: 4, data });
    const final = updates.filter((op) => op.op === "message.upsert").at(-1)!;
    const loaded = mapMessage(
      {
        id: messageID,
        type: "assistant",
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
        content: [],
        time: { created: 1, streamed: 3, completed: 4 },
      },
      id,
      { order: 1 },
    )!;
    assert(final.op === "message.upsert" && final.message.role === "assistant");
    assert(loaded.role === "assistant");
    assertEquals(final.message.time.lastOutput, loaded.time.lastOutput);
    assertEquals(loaded.time.lastOutput, 3);
  } finally {
    await transcript.stop();
  }
});
