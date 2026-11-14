// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { mapMessage, mapTool, partID } from "../map.ts";
import { factsFrom, scalarMessage } from "../transcript-reads.ts";
import { Messages, type NativeMessage } from "../messages.ts";
import { MessagePrefetchCache } from "../prefetch.ts";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";
import { createTranscriptProjection, emptyContent, reduce } from "@otk/client";
import type { ContentOp, MessagePolicy } from "@otk/protocol";
import { mergePromptSelection, usageHeader, UsageLedger } from "@otk/protocol";
const id = ids.encode("ses_fixture");
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
const assistant = (
  key: string,
  created = 1,
): Extract<NativeMessage, { type: "assistant" }> => ({
  type: "assistant",
  id: key,
  agent: "build",
  model: { providerID: "fake", id: "scripted" },
  content: [],
  time: { created, completed: created + 1 },
});
const user = (key: string): NativeMessage => ({
  type: "user",
  id: key,
  text: key,
  time: { created: 1 },
});
Deno.test("V2 live historical tools and snapshot checkpoints use the same interpretation", async () => {
  const updates: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No native read expected");
    },
    policy,
    content: (_id, op) => updates.push(op),
    diagnostic() {},
    invalidated() {},
  });
  transcript.subscriptions(id, 1);
  try {
    await transcript.event({
      type: "session.step.started",
      created: 1,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: "msg",
        agent: "build",
        model: { id: "model", providerID: "test" },
      },
    });
    for (
      const [name, input, metadata] of [
        ["read", { filePath: "/legacy.ts", offset: 190, limit: 50 }, {}],
        ["apply_patch", {}, {
          files: [{
            filePath: "/legacy.ts",
            type: "update",
            additions: 1,
            deletions: 1,
          }],
        }],
        ["bash", { command: "pwd", workdir: "/repo" }, {}],
        ["task", { subagent_type: "junior", description: "Inspect" }, {
          sessionId: "ses_child",
        }],
      ] as const
    ) {
      const data = {
        sessionID: "ses_fixture",
        assistantMessageID: "msg",
        id: name,
      };
      await transcript.event({
        type: "session.tool.input.started",
        created: 2,
        data: { ...data, name },
      });
      await transcript.event({
        type: "session.tool.called",
        created: 3,
        data: { ...data, input },
      });
      await transcript.event({
        type: "session.tool.success",
        created: 4,
        data: { ...data, metadata, content: [{ type: "text", text: "ok" }] },
      });
      const op = updates.filter((o) =>
        o.op === "part.upsert" && o.part.kind === "tool" &&
        o.part.call.callID === name
      ).at(-1);
      assert(op?.op === "part.upsert" && op.part.kind === "tool");
      const expected = mapTool({
        type: "tool",
        id: name,
        name,
        executed: false,
        time: { created: 2, ran: 3, completed: 4 },
        state: {
          status: "completed",
          input,
          metadata: JSON.parse(JSON.stringify(metadata)),
          content: [{ type: "text", text: "ok" }],
        },
      });
      if (expected.tool === "task") {
        expected.progress = {
          state: "digesting",
          progress: { state: "pending" },
          revision: 0,
        };
      }
      assertEquals(op.part.call, expected);
    }
  } finally {
    await transcript.stop();
  }
});
Deno.test("V2 standalone context kinds stay visible without becoming real prompts", () => {
  for (const type of ["synthetic", "system", "skill"] as const) {
    const raw = {
      id: "context",
      type,
      text: "Native context text",
      time: { created: 1 },
      ...(type === "skill" ? { skill: "canary", name: "Canary" } : {}),
    } as NativeMessage;
    const mapped = mapMessage(raw, id, { order: 1 })!;
    assertEquals(mapped.role, "context");
    const part = mapped.parts[0];
    assert(part.kind === "external" && part.activity);
    assertEquals(part.name, `opencode-v2/${type}`);
    assertEquals(mapped.role === "user" && mapped.origin === undefined, false);
  }
});
Deno.test("V2 compaction carries its own lifecycle without becoming a prompt", () => {
  for (const status of ["running", "completed", "failed"] as const) {
    const raw = {
      id: "msg_compaction",
      type: "compaction",
      status,
      reason: "manual",
      summary: "summary",
      error: { type: "unknown", message: "Summary failed" },
      time: { created: 1 },
    } as NativeMessage;
    const message = mapMessage(raw, id, { order: 1 })!;
    assertEquals(message.role, "context");
    const part = message.parts.find((part) => part.kind === "compaction")!;
    assertEquals(Reflect.get(part, "status"), status);
    assertEquals(JSON.parse(JSON.stringify(part)).status, status);
    const summary = message.parts.find((part) => part.kind === "text");
    assertEquals(summary?.kind === "text" && summary.synthetic === true, false);
    if (status === "failed") {
      assertEquals(JSON.stringify(summary).includes("Summary failed"), true);
    }
  }
});

Deno.test("V2 queued compaction is provider context and keeps its inbox owner", async () => {
  const updates: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No native read expected");
    },
    policy,
    content: (_id, op) => {
      updates.push(op);
    },
    diagnostic() {},
    invalidated() {},
  });
  transcript.subscriptions(id, 1);
  try {
    await transcript.event({
      type: "session.inbox.enqueued",
      id: "evt_queue",
      created: 1,
      data: {
        sessionID: "ses_fixture",
        inboxID: "msg_queued",
        item: { type: "compaction", delivery: "queue", payload: {} },
      },
    });
    const event = updates.find((op) => op.op === "message.upsert");
    assertEquals(
      event?.op === "message.upsert" && event.message.id,
      "msg_queued",
    );
    assertEquals(
      event?.op === "message.upsert" && event.message.role,
      "context",
    );
    assertEquals(
      event?.op === "message.upsert" &&
        Reflect.get(event.message.parts[0], "status"),
      "queued",
    );
  } finally {
    await transcript.stop();
  }
});

Deno.test("V2 successive compactions keep distinct native lifecycle owners", async () => {
  const updates: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No native read expected");
    },
    policy,
    content: (_id, op) => {
      updates.push(op);
    },
    diagnostic() {},
    invalidated() {},
  });
  transcript.subscriptions(id, 1);
  try {
    for (const key of ["first", "second"]) {
      await transcript.event({
        type: "session.compaction.started",
        id: `evt_${key}`,
        created: 1,
        data: {
          sessionID: "ses_fixture",
          inputID: `msg_${key}`,
          reason: "manual",
        },
      });
      await transcript.event({
        type: "session.compaction.ended",
        id: `evt_${key}_end`,
        created: 2,
        data: { sessionID: "ses_fixture", reason: "manual", text: key },
      });
    }
    assertEquals(
      updates.flatMap((op) =>
        op.op === "message.upsert" ? [op.message.id] : []
      ),
      ["msg_first", "msg_first", "msg_second", "msg_second"],
    );
  } finally {
    await transcript.stop();
  }
});
Deno.test("re-staging the same message retires body authority for file-mode changes", async () => {
  const notices: unknown[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No body acquisition permitted");
    },
    policy,
    content() {},
    diagnostic() {},
    invalidated: (value) => notices.push(value),
  });
  const stage = {
    type: "session.revert.staged",
    data: {
      sessionID: "ses_fixture",
      revert: { messageID: "msg_boundary", files: [] },
    },
  };
  await transcript.event(stage);
  const first = transcript.replay.version(id),
    epoch = transcript.replay.clock(id).epoch;
  await transcript.event({
    ...stage,
    data: {
      ...stage.data,
      revert: {
        messageID: "msg_boundary",
        files: [{ file: "a.ts", additions: 1, deletions: 2 }],
      },
    },
  });
  assertEquals(transcript.replay.version(id), {
    generation: first.generation,
    revision: first.revision + 1,
  });
  assert(transcript.replay.clock(id).epoch !== epoch);
  assertEquals(notices.length, 2);
  await transcript.stop();
});
Deno.test("an already-observed API revert is not invalidated again by its delayed stage event", async () => {
  const notices: unknown[] = [];
  const transcript = new Transcript({
    client: () => {
      throw new Error("No body acquisition permitted");
    },
    policy,
    content() {},
    diagnostic() {},
    invalidated: (value) => notices.push(value),
  });
  const revert = { messageID: "msg_boundary", files: [] };
  transcript.observe({
    id: "ses_fixture",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    location: { directory: "/project" },
    revert,
  });
  const version = transcript.replay.version(id),
    epoch = transcript.replay.clock(id).epoch;
  await transcript.event({
    type: "session.revert.staged",
    data: { sessionID: "ses_fixture", revert },
  });
  assertEquals(transcript.replay.version(id), version);
  assertEquals(transcript.replay.clock(id).epoch, epoch);
  assertEquals(notices.length, 1);
  await transcript.stop();
});
Deno.test("V2 model selection replaces its variant in content and latest-prompt metadata", () => {
  const model = { provider: "fake", model: "first" },
    next = { provider: "fake", model: "second" };
  const first = reduce(emptyContent(), {
    op: "session.selection",
    selection: { agent: "build", model, variant: "deep" },
  });
  const wire = JSON.parse(
    JSON.stringify({
      op: "session.selection",
      selection: { model: next, variant: undefined },
    }),
  );
  assertEquals(reduce(first, wire).selection, {
    agent: "build",
    model: next,
    variant: undefined,
  });
  assertEquals(
    mergePromptSelection({
      id: "prompt",
      agent: "build",
      model,
      variant: "deep",
    }, wire.selection),
    { id: "prompt", agent: "build", model: next, variant: undefined },
  );
  assertEquals(
    mergePromptSelection({ model, variant: "deep" }, { agent: "plan" }),
    { agent: "plan", model, variant: "deep" },
  );
});
Deno.test("V2 content ordinal identity counts text and reasoning independently, tool calls by ID", () => {
  const raw = assistant("msg_fork_10");
  raw.content = [
    { type: "reasoning", text: "think" },
    { type: "text", text: "first" },
    {
      type: "tool",
      id: "call",
      name: "subagent",
      state: {
        status: "completed",
        input: { agent: "explore", description: "inspect" },
        metadata: { sessionID: "ses_child" },
        content: [{ type: "text", text: "found" }],
      },
      time: { created: 1, completed: 2 },
    },
    { type: "text", text: "last" },
    { type: "reasoning", text: "again" },
  ];
  const mapped = mapMessage(raw, id, { order: 10, replyTo: "prompt" })!;
  assertEquals(mapped.parts.map((p) => p.id), [
    "msg_fork_10:start",
    partID(raw.id, "reasoning", 0),
    partID(raw.id, "text", 0),
    partID(raw.id, "tool", "call"),
    partID(raw.id, "text", 1),
    partID(raw.id, "reasoning", 1),
    "msg_fork_10:finish",
  ]);
  const tool = mapped.parts[3];
  assert(tool.kind === "tool" && tool.call.tool === "task");
  assertEquals(tool.call.childSessionID, ids.encode("ses_child"));
  assert(mapped.role === "assistant");
  assertEquals(mapped.cost, null);
  assertEquals(mapped.tokens.input, null);
});
Deno.test("V2 all native message kinds are context or controls, never fake real prompts", () => {
  const rows: NativeMessage[] = [user("msg_user"), {
    id: "msg_synthetic",
    type: "synthetic",
    text: "context",
    time: { created: 1 },
  }, {
    id: "msg_system",
    type: "system",
    text: "instructions",
    time: { created: 1 },
  }, {
    id: "msg_skill",
    type: "skill",
    skill: "skill_fixture",
    name: "fixture",
    text: "body",
    time: { created: 1 },
  }, {
    id: "msg_shell",
    type: "shell",
    shellID: "sh_fixture",
    command: "pwd",
    status: "exited",
    exit: 0,
    output: { output: "/project", cursor: 8, size: 8, truncated: false },
    time: { created: 1, completed: 2 },
  }, {
    id: "msg_compact",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "summary",
    time: { created: 1 },
  }, {
    id: "msg_agent",
    type: "agent-switched",
    agent: "plan",
    time: { created: 1 },
  }, {
    id: "msg_model",
    type: "model-switched",
    model: { providerID: "fake", id: "second" },
    time: { created: 1 },
  }, {
    id: "msg_location",
    type: "location-switched",
    location: { directory: "/other" },
    time: { created: 1 },
  }, {
    id: "msg_idle",
    type: "idle",
    outcome: "succeeded",
    time: { created: 1 },
  }, assistant("msg_assistant")];
  const mapped = rows.flatMap((r, i) => {
    const m = mapMessage(r, id, { order: i });
    return m ? [m] : [];
  });
  assertEquals(mapped.length, rows.length);
  const projection = createTranscriptProjection();
  projection.replace(mapped);
  projection.busy(true);
  assertEquals([...projection.state.queuedIDs], []);
  assertEquals(
    mapped.filter((m) => m.role === "user" && m.origin === undefined).map((m) =>
      m.id
    ),
    ["msg_user"],
  );
});
Deno.test("V2 real-user anchors and selection follow seq, not copied clocks or fork IDs", () => {
  const rows = [
    {
      type: "agent-switched",
      id: "msg_fork_2",
      agent: "plan",
      time: { created: 1 },
    } as NativeMessage,
    user("msg_fork_9"),
    assistant("msg_fork_10"),
    {
      type: "synthetic",
      id: "msg_fork_11",
      text: "generated",
      time: { created: 1 },
    } as NativeMessage,
    assistant("msg_fork_12"),
    user("msg_fork_13"),
    assistant("msg_fork_14"),
  ];
  const facts = factsFrom(
    rows.map((r, i) => scalarMessage(r, i)),
    rows.map((r) => r.id),
  );
  assertEquals(facts.contexts.msg_fork_12.replyTo, "msg_fork_9");
  assertEquals(facts.contexts.msg_fork_14.replyTo, "msg_fork_13");
  assertEquals(facts.metadata.prompt?.agent, "plan");
  const projection = createTranscriptProjection();
  projection.replace(
    [...rows].reverse().flatMap((r) => {
      const m = mapMessage(r, id, facts.contexts[r.id]);
      return m ? [m] : [];
    }),
  );
  assertEquals(projection.state.messageIDs, [
    "msg_fork_2",
    "msg_fork_9",
    "msg_fork_10",
    "msg_fork_11",
    "msg_fork_12",
    "msg_fork_13",
    "msg_fork_14",
  ]);
});
Deno.test("V2 cursor native reader omits order on continuation and bounds every request", async () => {
  const requests: unknown[] = [];
  const api = {
    message: {
      list: (input: unknown) => {
        requests.push(input);
        return Promise.resolve({
          data: [user("msg_user")],
          cursor: { next: "opaque" },
        });
      },
    },
  };
  const client = {
    read: <T>(run: (api: unknown) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const reader = new Messages(() => client);
  await reader.page(id, 1);
  await reader.page(id, 1, "opaque");
  assertEquals(requests, [
    { sessionID: "ses_fixture", limit: 1, order: "desc" },
    { sessionID: "ses_fixture", limit: 1, cursor: "opaque" },
  ]);
  await assertRejects(() => reader.page(id, 0), RangeError);
});
Deno.test("V2 cache charges complete UTF8 key and payload, uses insertion TTL and aggregate FIFO", () => {
  let now = 0;
  const cache = new MessagePrefetchCache({
      prefetchms: 10,
      prefetchbytes: 1000,
    }, () => now),
    value = {
      page: { items: [], next: "next" },
      facts: {
        source: "api" as const,
        contexts: {},
        metadata: { boundaries: [] },
      },
    };
  cache.put(id, "key", value);
  const expected = new TextEncoder().encode(JSON.stringify(value)).length +
    new TextEncoder().encode(JSON.stringify([id, "key"])).length;
  assertEquals(cache.bytes, expected);
  assertEquals(cache.get("key"), value);
  now = 10;
  assertEquals(cache.get("key"), undefined);
  assertEquals(cache.bytes, 0);
  cache.put(id, "x".repeat(1000), value);
  assertEquals(cache.bytes, 0);
});
Deno.test("V2 live terminal text replaces deltas, preserving stable part identity", async () => {
  const ops: ContentOp[] = [],
    t = new Transcript({
      client: () => {
        throw new Error("no native read expected");
      },
      policy,
      content: (_id, op) => ops.push(op),
      invalidated: () => {},
      diagnostic: () => {},
    });
  t.subscriptions(id, 1);
  await t.event({
    type: "session.step.started",
    created: 1,
    durable: { seq: 1 },
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: "msg_live",
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
      started: 1,
    },
  });
  await t.event({
    type: "session.reasoning.started",
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: "msg_live",
      ordinal: 0,
    },
  });
  await t.event({
    type: "session.text.started",
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: "msg_live",
      ordinal: 0,
    },
  });
  await t.event({
    type: "session.text.delta",
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: "msg_live",
      ordinal: 0,
      delta: "hello",
    },
  });
  await t.event({
    type: "session.text.ended",
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: "msg_live",
      ordinal: 0,
      text: "hello world",
    },
  });
  const last = ops.at(-1);
  assert(last?.op === "part.upsert" && last.part.kind === "text");
  assertEquals(JSON.stringify(last.part.blocks).includes("hello world"), true);
  assertEquals(JSON.stringify(last.part.blocks).includes("hellohello"), false);
  assertEquals(last.part.id, partID("msg_live", "text", 0));
  await t.stop();
});
Deno.test("V2 retry reopens the same message only with explicit new-start authority", async () => {
  const projection = createTranscriptProjection(), ledger = new UsageLedger(id);
  const t = new Transcript({
    client: () => {
      throw new Error("no reads expected");
    },
    policy,
    content: (_id, op) => {
      projection.apply(op);
      if (op.op === "message.upsert" && op.message.role === "assistant") {
        ledger.upsert(usageHeader(op.message), op.restart);
      }
    },
    invalidated: () => {},
    diagnostic: () => {},
  });
  t.subscriptions(id, 1);
  const start = (created: number) =>
    t.event({
      type: "session.step.started",
      created,
      durable: { seq: 1 },
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: "msg_retry",
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
        started: created,
      },
    });
  try {
    await start(1);
    await t.event({
      type: "session.step.failed",
      created: 2,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: "msg_retry",
        error: { type: "unknown", message: "retry me" },
      },
    });
    assertEquals(Reflect.get(projection.messages()[0].time, "completed"), 2);
    await start(1);
    assertEquals(Reflect.get(projection.messages()[0].time, "completed"), 2);
    await start(3);
    assertEquals(
      Reflect.get(projection.messages()[0].time, "completed"),
      undefined,
    );
    assertEquals(ledger.detail("msg_retry").calls[0].completed, false);
    assertEquals(
      projection.messages()[0].parts.some((p) =>
        p.kind === "step" && p.phase === "finish"
      ),
      false,
    );
  } finally {
    await t.stop();
  }
});
Deno.test("V2 unknown native content stays bounded and cannot become a prompt anchor", () => {
  const raw = assistant("msg_future");
  raw.content = [
    {
      type: "future",
      secret: "x".repeat(20000),
    } as unknown as typeof raw.content[number],
  ];
  const message = mapMessage(raw, id, { order: 1 })!;
  const external = message.parts.find((p) => p.kind === "external");
  assert(external?.kind === "external");
  assert(typeof external.data === "string" && external.data.length <= 16384);
  const future = mapMessage(
    {
      id: "msg_future_kind",
      type: "future",
      time: { created: 1 },
      value: "x".repeat(20000),
    } as unknown as NativeMessage,
    id,
    { order: 2 },
  )!;
  assertEquals(future.role, "context");
  assert(future.source?.truncated);
  assertEquals(future.source?.preview.length, 16384);
  assertEquals(createTranscriptProjection().state.queuedIDs.size, 0);
});
Deno.test("V2 untested cutoff scan uses bounded ordinary pages and preserves exact continuation", async () => {
  const requests: Record<string, unknown>[] = [],
    rows = Array.from({ length: 20 }, (_, i) => user(`msg_${i}`));
  const api = {
    message: {
      list: (input: Record<string, unknown>) => {
        requests.push(input);
        return Promise.resolve(
          input.cursor
            ? {
              data: rows.slice(0, 10).reverse(),
              cursor: { next: "exact-older" },
            }
            : {
              data: rows.slice(10).reverse(),
              cursor: { next: "exact-boundary" },
            },
        );
      },
    },
  };
  const reader = new Messages(
    () => ({
      read: <T>(run: (value: unknown) => Promise<T>) => run(api),
    } as unknown as V2Client),
  );
  const page = await reader.before(id, "msg_5", new AbortController().signal);
  assertEquals(page.items.map((r) => r.id), [
    "msg_0",
    "msg_1",
    "msg_2",
    "msg_3",
    "msg_4",
  ]);
  assertEquals(page.next, "exact-older");
  assertEquals(requests, [{
    sessionID: "ses_fixture",
    limit: 10,
    order: "desc",
  }, { sessionID: "ses_fixture", limit: 10, cursor: "exact-boundary" }]);
});
Deno.test("V2 unsubscribe cancels and joins an in-flight reconnect body backfill", async () => {
  const entered = Promise.withResolvers<AbortSignal>(),
    outer = new AbortController();
  const client = {
    service: { version: "2.2.6" },
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        session: {
          get: (_input: unknown, options: { signal: AbortSignal }) => {
            entered.resolve(options.signal);
            return new Promise((_resolve, reject) =>
              options.signal.addEventListener("abort", () =>
                reject(options.signal.reason), { once: true })
            );
          },
        },
      }),
  } as unknown as V2Client;
  const t = new Transcript({
    client: () => client,
    policy,
    content: () => {},
    invalidated: () => {},
    diagnostic: () => {},
  });
  t.subscriptions(id, 1);
  await t.event({
    type: "session.step.started",
    created: 1,
    data: {
      sessionID: "ses_fixture",
      assistantMessageID: "msg_unsubscribe",
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
      started: 1,
    },
  });
  const commit = t.resync(client, outer.signal), running = commit();
  void running.catch(() => {});
  try {
    const signal = await entered.promise;
    t.subscriptions(id, 0);
    assertEquals(signal.aborted, true);
    await running;
  } finally {
    outer.abort();
    await running.catch(() => {});
    await t.stop();
  }
});
Deno.test("V2 stale completed page cannot retire a newer retry or restore its finish marker", async () => {
  const raw = assistant("msg_retry_snapshot", 1),
    projection = createTranscriptProjection(),
    gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let block = false;
  const api = {
    session: {
      inbox: { list: () => Promise.resolve([]) },
      get: () =>
        Promise.resolve({
          id: "ses_fixture",
          projectID: "project",
          location: { directory: "/project" },
          time: { created: 1, updated: 3 },
        }),
    },
    message: { list: () => Promise.resolve({ data: [raw], cursor: {} }) },
  };
  const client = {
    service: { version: "2.2.6" },
    read: <T>(run: (api: unknown) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const t = new Transcript({
    client: () => client,
    policy,
    facts: async () => {
      if (block) {
        entered.resolve();
        await gate.promise;
      }
      return factsFrom([scalarMessage(raw, 1)], [raw.id]);
    },
    content: (_id, op) => projection.apply(op),
    invalidated: () => {},
    diagnostic: () => {},
  });
  t.subscriptions(id, 1);
  try {
    projection.replace((await t.page(id)).items);
    block = true;
    const reading = t.page(id);
    await entered.promise;
    await t.event({
      type: "session.step.started",
      created: 3,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: raw.id,
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
        started: 3,
      },
    });
    gate.resolve();
    const page = await reading;
    assertEquals(
      page.items[0].parts.some((p) =>
        p.kind === "step" && p.phase === "finish"
      ),
      false,
    );
    projection.replace(page.items);
    for (const { event } of page.catchup) projection.apply(event);
    assertEquals(
      projection.messages()[0].parts.some((p) =>
        p.kind === "step" && p.phase === "finish"
      ),
      false,
    );
    await t.event({
      type: "session.step.failed",
      created: 2,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: raw.id,
        error: { type: "unknown", message: "old attempt" },
      },
    });
    await t.event({
      type: "session.text.started",
      created: 4,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: raw.id,
        ordinal: 0,
      },
    });
    await t.event({
      type: "session.text.delta",
      created: 4,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: raw.id,
        ordinal: 0,
        delta: "new attempt",
      },
    });
    const deadline = performance.now() + 1000;
    while (
      !JSON.stringify(projection.messages()).includes("new attempt") &&
      performance.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assert(
      JSON.stringify(projection.messages()).includes("new attempt"),
      JSON.stringify(projection.messages()),
    );
  } finally {
    gate.resolve();
    await t.stop();
  }
});
