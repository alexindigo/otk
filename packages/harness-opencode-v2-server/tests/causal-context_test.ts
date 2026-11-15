// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createTranscriptProjection } from "@otk/client";
import type { ContentOp, MessagePolicy } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";
import type { NativeMessage } from "../messages.ts";
import type { V2Event } from "../stream.ts";
import { Transcript } from "../transcript.ts";
import type { TranscriptFacts } from "../transcript-reads.ts";

const sessionID = ids.encode("ses_fixture");
const promptID = "msg_1df75333f001iPxLDqjf1F59iI";
const finalID = "msg_1df75504a001AoEU85efrkGkHO";
const previousID = "msg_1df754ff7001cKMpXJHkrXytA5";
const policy: MessagePolicy = {
  prefetchms: 1000,
  prefetchbytes: 100000,
  coolms: 1000,
  preloadms: 1000,
  concurrency: 2,
  replayops: 128,
  replaybytes: 1048576,
  recoveryconcurrency: 2,
  recoverypending: 32,
  retryms: 100,
};
function fixture(
  options: { hold?: boolean; latest?: string; unfinished?: boolean } = {},
) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const updates: ContentOp[] = [];
  const raw: Extract<NativeMessage, { type: "assistant" }> = {
    id: finalID,
    type: "assistant",
    agent: "build",
    model: { providerID: "fake", id: "scripted" },
    content: [{ type: "text", text: "Projection step 101." }],
    time: { created: 916, ...(options.unfinished ? {} : { completed: 919 }) },
  };
  const previous = {
    ...raw,
    id: previousID,
    time: { created: 907, completed: 915 },
  };
  const api = {
    session: {
      get: () =>
        Promise.resolve({
          id: "ses_fixture",
          projectID: "project",
          location: { directory: "/project" },
          time: { created: 1, updated: 919 },
        }),
    },
    message: {
      list: () => Promise.resolve({ data: [raw, previous], cursor: {} }),
    },
  };
  const client = {
    service: { version: "2.2.6" },
    read: <T>(run: (value: unknown) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const facts: TranscriptFacts = {
    source: "sql:causal-fixture",
    contexts: {
      [previousID]: { order: 907, replyTo: promptID },
      [finalID]: { order: 916, replyTo: promptID },
    },
    metadata: {
      prompt: { id: options.latest ?? promptID },
      boundaries: [{
        turnID: promptID,
        firstID: previousID,
        lastID: finalID,
        complete: true,
      }],
    },
  };
  const value = new Transcript({
    client: () => client,
    policy,
    facts: async () => {
      entered.resolve();
      if (options.hold) await gate.promise;
      return structuredClone(facts);
    },
    content: (_id, op) => updates.push(op),
    invalidated() {},
    diagnostic(error) {
      throw error;
    },
  });
  value.subscriptions(sessionID, 1);
  const event = (
    type: string,
    extra: Record<string, unknown> = {},
  ): V2Event => ({
    type: `session.${type}`,
    created: type === "step.started" ? 916 : 919,
    durable: {
      aggregateID: "ses_fixture",
      seq: type === "step.started" ? 916 : 919,
    },
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: finalID,
      ...extra,
    },
  });
  const start = (extra: Record<string, unknown> = {}) =>
    value.event(event("step.started", {
      started: 916,
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
      ...extra,
    }));
  return { value, updates, entered, gate, facts, start, event };
}

Deno.test("V2 causal context: captured 102-call final headers cannot split first-page replay", async () => {
  const f = fixture({ hold: true });
  const reading = f.value.page(sessionID);
  try {
    await f.entered.promise;
    await f.start();
    await f.value.event(
      f.event("text.ended", { ordinal: 0, text: "Projection step 101." }),
    );
    await f.value.event(f.event("step.streamed"));
    await f.value.event(f.event("step.ended", { finish: "stop" }));
    // The retained trace has three final-message headers before page/catchup.
    assertEquals(
      f.updates.filter((op) => op.op === "message.upsert").length,
      3,
    );
    f.gate.resolve();
    const page = await reading;
    const projection = createTranscriptProjection();
    projection.replace(page.items);
    for (const { event } of page.catchup) projection.apply(event);
    assertEquals(projection.state.replyIDs, [`reply:${promptID}`]);
    assertEquals(
      projection.messages().map((message) =>
        message.role === "assistant" && message.replyTo
      ),
      [promptID, promptID],
    );
    assert(
      page.catchup.every(({ event }) =>
        event.op !== "message.upsert" || event.message.role !== "assistant" ||
        event.message.replyTo === promptID
      ),
    );
    assert(
      JSON.stringify(projection.messages()).includes("Projection step 101."),
    );
  } finally {
    f.gate.resolve();
    await reading.catch(() => {});
    await f.value.stop();
  }
});

Deno.test("V2 causal context: native parentID admits a live assistant before baseline", async () => {
  const f = fixture();
  try {
    await f.start({ parentID: promptID });
    const header = f.updates.find((op) => op.op === "message.upsert");
    assert(
      header?.op === "message.upsert" && header.message.role === "assistant",
    );
    assertEquals(header.message.replyTo, promptID);
  } finally {
    await f.value.stop();
  }
});

Deno.test("V2 causal context: native parent metadata wins over a newer open prompt", async () => {
  const f = fixture({ latest: "msg_newer_prompt" });
  try {
    await f.value.page(sessionID);
    const start = f.event("step.started", {
      assistantMessageID: "msg_parented_step",
      started: 916,
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
    });
    await f.value.event(
      { ...start, metadata: { parentID: promptID } } as V2Event,
    );
    const header = f.updates.find((op) => op.op === "message.upsert");
    assert(
      header?.op === "message.upsert" && header.message.role === "assistant",
    );
    assertEquals(header.message.replyTo, promptID);
  } finally {
    await f.value.stop();
  }
});

Deno.test("V2 causal context: accepted native open prompt anchors a later unknown step", async () => {
  const f = fixture();
  try {
    await f.value.page(sessionID);
    await f.value.event(f.event("step.started", {
      assistantMessageID: "msg_next",
      started: 920,
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
    }));
    const header = f.updates.find((op) => op.op === "message.upsert");
    assert(
      header?.op === "message.upsert" && header.message.role === "assistant",
    );
    assertEquals(header.message.replyTo, promptID);
  } finally {
    await f.value.stop();
  }
});

Deno.test("V2 causal context: scalar message association survives a newer current prompt", async () => {
  const f = fixture({ latest: "msg_newer_prompt", unfinished: true });
  try {
    await f.value.page(sessionID);
    await f.start();
    const header = f.updates.find((op) => op.op === "message.upsert");
    assert(
      header?.op === "message.upsert" && header.message.role === "assistant",
    );
    assertEquals(header.message.replyTo, promptID);
  } finally {
    await f.value.stop();
  }
});
