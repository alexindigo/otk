// SPDX-License-Identifier: LGPL-3.0-only
import { referenced } from "../native-source.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type ContentOp,
  type ExternalPart,
  isRealPrompt,
  type MessagePolicy,
} from "@otk/protocol";
import { inboxMessage, mapMessage, mapTool } from "../map.ts";
import type { NativeMessage } from "../messages.ts";
import { Transcript } from "../transcript.ts";
import { subagentBody } from "../tool-results.ts";

const sid = "opcv2-ses_fixture";
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
function notice(raw: NativeMessage): ExternalPart {
  const message = mapMessage(raw, sid, { order: 1 });
  assert(message);
  assertEquals(message.role, "context");
  assertEquals(isRealPrompt(message), false);
  assertEquals(
    message.source?.payload,
    "text" in raw ? raw.text : JSON.stringify(raw),
  );
  const part = message.parts[0];
  assert(part.kind === "external" && part.activity);
  return part;
}
const synthetic = (
  state = "completed",
  description = 'Inspect "quoted"\nmultiline task',
): NativeMessage => ({
  id: "msg_notice",
  type: "synthetic",
  description,
  text:
    `<subagent sessionID="ses_child" state="${state}" description="${description}">\n**Result**\n\n| key | value |\n| --- | --- |\n| a | b |\n\nNested <subagent literal> stays.\n</subagent>`,
  metadata: {
    source: "subagent",
    state,
    agent: "junior",
    childID: "ses_child",
  },
  time: { created: 1 },
});

// INV-A's V2 cases, retargeted to the binding visible context carrier.
for (
  const [state, title, tone, facts] of [
    ["completed", "Junior finished", "normal", {
      active: false,
      terminal: true,
    }],
    ["error", "Junior failed", "error", { active: false, terminal: true }],
    ["cancelled", "Junior cancelled", "normal", {
      active: false,
      terminal: true,
    }],
    ["future-state", "Junior finished", "normal", {
      active: null,
      terminal: null,
    }],
  ] as const
) {
  Deno.test(`V2 subagent ${state} preserves native state, parameters, source and rendered response`, () => {
    const part = notice(synthetic(state)), activity = part.activity!;
    assertEquals(activity.title, title);
    assertEquals(activity.tone, tone);
    assertEquals(activity.state?.facts, facts);
    assertEquals(activity.state?.key, state);
    assertEquals(activity.child?.sessionID, "opcv2-ses_child");
    assertEquals(activity.parameters?.map((p) => p.key), [
      "agent",
      "state",
      "description",
      "sessionID",
    ]);
    assertEquals(
      activity.parameters?.at(-1)?.child?.sessionID,
      activity.child?.sessionID,
    );
    const body = JSON.stringify(activity.body);
    assert(body.includes('"i":"strong"'));
    assert(body.includes('"b":"table"'));
    const native = synthetic(state);
    assert(native.type === "synthetic");
    const inner = subagentBody(
      native.text,
      "ses_child",
      state,
      native.description,
    );
    assert(inner?.includes("Nested <subagent literal> stays."));
    assert(body.includes("<subagent literal>"));
    assert(!body.includes('sessionID="ses_child"'));
  });
}
Deno.test("V2 trusts metadata, not wrapper-like prose, and malformed envelopes retain their whole source", () => {
  const raw = synthetic();
  assert(raw.type === "synthetic");
  const malformed = { ...raw, text: raw.text.slice(0, -2) };
  assertEquals(
    notice(malformed).activity?.body,
    notice({ ...malformed, metadata: {} }).activity?.body,
  );
  const ordinary = notice({ ...raw, metadata: {} });
  assertEquals(ordinary.activity?.child, undefined);
  assertEquals(ordinary.activity?.category, "record");
  assert(
    JSON.stringify(ordinary.activity?.body).includes("subagent sessionID"),
  );
});
Deno.test("V2 System, skill, outgoing continuations and unknown records are visible, separate native items", () => {
  const system = notice({
    id: "msg_system",
    type: "system",
    text: "First line\nFull text",
    time: { created: 1 },
  });
  assertEquals(system.activity?.title, "System");
  assertEquals(system.activity?.detail, "First line");
  // The native text is declared message content; Copy never uses the JSON source.
  assertEquals(system.content, true);
  assertEquals(system.source?.payload, "First line\nFull text");
  const skill = notice({
    id: "msg_skill",
    type: "skill",
    name: "Review",
    skill: "review-id",
    text: "skill body",
    metadata: { extra: "retained" },
    time: { created: 1 },
  });
  assertEquals(skill.activity?.title, "Skill Review");
  assert(skill.source?.preview?.includes("review-id"));
  assert(skill.source?.preview?.includes("retained"));
  for (
    const text of [
      "",
      "  ",
      "The environment you are running in is now: <env>/repo</env>",
      "Goal continuation",
    ]
  ) {
    const part = notice({
      id: "msg_env",
      type: "synthetic",
      text,
      time: { created: 1 },
    });
    assertEquals(part.activity?.direction, "outgoing");
    assertEquals(part.activity?.category, "outgoing");
  }
  const unknown = mapMessage(
    {
      id: "msg_future",
      type: "future",
      text: "opaque",
      time: { created: 1 },
      extra: true,
    } as unknown as NativeMessage,
    sid,
    { order: 1 },
  );
  assert(unknown?.parts[0].kind === "external");
  assert(unknown.parts[0].source?.preview?.includes('"extra":true'));
});
Deno.test("V2 shell rows keep process failure distinct from native completion", () => {
  for (
    const metadata of [
      {
        source: "shell",
        shellID: "sh_1",
        state: "completed",
        exit: 9,
        truncated: true,
      },
      { source: "shell", shellID: "sh_1", state: "completed", timeout: true },
      {
        source: "shell",
        shellID: "sh_1",
        state: "cancelled",
        signal: "SIGTERM",
      },
    ] as NonNullable<NativeMessage["metadata"]>[]
  ) {
    const part = notice({
      id: "msg_shell",
      type: "synthetic",
      text: "literal **output**",
      description: "pwd",
      metadata,
      time: { created: 1 },
    });
    assertEquals(part.activity?.state?.key, metadata.state);
    assertEquals(part.activity?.tone, "error");
    assert(
      part.activity?.parameters?.some((p) =>
        ["exit", "timeout", "signal"].includes(p.key)
      ),
    );
  }
});

for (
  const [type, data, metadata, raw] of [
    [
      "session.synthetic",
      {
        text: "body",
        description: "LIVE_DESCRIPTION",
        metadata: {
          source: "subagent",
          childID: "ses_child",
          agent: "junior",
          state: "error",
        },
      },
      { envelope: true },
      {
        type: "synthetic",
        text: "body",
        description: "LIVE_DESCRIPTION",
        metadata: {
          source: "subagent",
          childID: "ses_child",
          agent: "junior",
          state: "error",
        },
      },
    ],
    [
      "session.instructions.updated",
      { text: "catalog body", delta: { codemode: "hash" } },
      { envelope: true },
      {
        type: "system",
        text: "catalog body",
        description: "Instructions updated: codemode",
        metadata: {
          envelope: true,
          notice: "instructions",
          instructionSources: ["codemode"],
        },
      },
    ],
    [
      "session.skill.activated",
      { text: "skill body", id: "test_skill", name: "Review" },
      { envelope: true },
      {
        type: "skill",
        text: "skill body",
        skill: "test_skill",
        name: "Review",
        metadata: { envelope: true },
      },
    ],
  ] as const
) {
  Deno.test(`V2 ${type} snapshot and live have identical items and IDs`, async () => {
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
    transcript.subscriptions(sid, 1);
    try {
      await transcript.event({
        type,
        id: "evt_notice",
        created: 1,
        metadata,
        durable: { seq: 1 },
        data: { sessionID: "ses_fixture", ...data },
      });
      const upsert = updates.find((op) => op.op === "message.upsert");
      assert(upsert?.op === "message.upsert");
      assertEquals(
        upsert.message,
        referenced(
          mapMessage(
            { ...raw, id: "msg_notice", time: { created: 1 } } as NativeMessage,
            sid,
            { order: 1 },
          ),
          "msg_notice",
        ),
      );
    } finally {
      await transcript.stop();
    }
  });
}
Deno.test("V2 textless instructions remain metadata-only, matching native persistence", async () => {
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
  transcript.subscriptions(sid, 1);
  try {
    await transcript.event({
      type: "session.instructions.updated",
      id: "evt_baseline",
      created: 1,
      data: { sessionID: "ses_fixture", delta: { codemode: "hash" } },
    });
    assertEquals(updates.filter((op) => op.op === "message.upsert"), []);
  } finally {
    await transcript.stop();
  }
});
Deno.test("V2 every inbox payload uses the same classification for queued snapshot and live admission", async () => {
  const updates: ContentOp[] = [],
    transcript = new Transcript({
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
  transcript.subscriptions(sid, 1);
  try {
    for (
      const [index, item] of [
        { type: "user", delivery: "queue", payload: { text: "Prompt" } },
        {
          type: "synthetic",
          delivery: "queue",
          payload: { text: "Goal continuation", metadata: { source: "goal" } },
        },
        {
          type: "move",
          delivery: "queue",
          payload: { location: { directory: "/other" }, projectID: "p" },
        },
        { type: "compaction", delivery: "queue", payload: {} },
      ].entries()
    ) {
      const id = `msg_inbox_${index}`;
      await transcript.event({
        type: "session.inbox.enqueued",
        created: 1,
        durable: { seq: index + 1 },
        data: { sessionID: "ses_fixture", inboxID: id, item },
      });
      const op = updates.filter((op) => op.op === "message.upsert").at(-1);
      assert(op?.op === "message.upsert");
      assertEquals(
        op.message,
        inboxMessage(id, item, 1, sid, { order: index + 1 }),
      );
      assertEquals(isRealPrompt(op.message), item.type === "user");
    }
  } finally {
    await transcript.stop();
  }
});

Deno.test("TL1b keeps raw streaming input, all residual fields and ordered text/file/media results", () => {
  const base = {
    type: "tool" as const,
    id: "call",
    name: "read",
    native: { provider: "opaque" },
    time: { created: 1 },
  };
  const pending = mapTool({
    ...base,
    state: { status: "streaming", input: '{"path": "par' },
  });
  assertEquals(
    JSON.parse(pending.source!.payload!).state.input,
    '{"path": "par',
  );
  const content: Extract<
    Parameters<typeof mapTool>[0]["state"],
    { status: "completed" }
  >["content"] = [
    { type: "text" as const, text: "first" },
    {
      type: "file" as const,
      name: "chart.png",
      mime: "image/png",
      uri: "https://example.invalid/chart.png",
    },
    { type: "text" as const, text: "last" },
    {
      type: "file" as const,
      name: "report.pdf",
      mime: "application/pdf",
      uri: "file:///reports/report.pdf",
    },
  ];
  const raw = {
    ...base,
    state: {
      status: "completed" as const,
      input: { path: "/a", extra: "input-extra" },
      metadata: { extra: "metadata-extra" },
      content,
    },
  };
  const call = mapTool(raw);
  assertEquals(JSON.parse(call.source!.payload!), raw);
  assertEquals(call.outputContent?.kind, "blocks");
  const rendered = JSON.stringify(call.outputContent);
  assert(rendered.indexOf("first") < rendered.indexOf("chart.png"));
  assert(rendered.indexOf("chart.png") < rendered.indexOf("last"));
  assert(rendered.indexOf("last") < rendered.indexOf("report.pdf"));
  assert(rendered.includes("application/pdf"));
  assert(rendered.includes("file:///reports/report.pdf"));
});
Deno.test("V2 assistant and typed-part source retains finish, clocks, retry, variant, errors and provider data", () => {
  const raw: Extract<NativeMessage, { type: "assistant" }> = {
    id: "msg_residual",
    type: "assistant",
    agent: "build",
    model: { providerID: "fake", id: "scripted", variant: "high" },
    finish: "error",
    rawFinish: "provider-stop",
    native: { blocked: "detail" },
    retry: {
      attempt: 2,
      at: 12,
      error: {
        type: "provider.quota",
        message: "quota",
        status: 403,
        response: { body: "provider response" },
      },
    },
    error: {
      type: "provider.quota",
      message: "quota",
      status: 403,
      response: { body: "provider response" },
      retryAfterMs: 10,
    },
    snapshot: { start: "before", end: "after", files: ["a.ts"] },
    content: [{
      type: "text",
      text: "**Exact answer**\n",
      native: { phase: "final" },
    }, {
      type: "reasoning",
      text: "Reason",
      native: { signature: "opaque" },
      time: { created: 1, completed: 2 },
    }],
    time: { created: 1, streamed: 3, completed: 4 },
  };
  const message = mapMessage(raw, sid, { order: 1 });
  assertEquals(message.source?.payload, "**Exact answer**\n");
  assertEquals(JSON.parse(message.source!.preview!), raw);
  const part = message.parts.find((p) => p.kind === "reasoning");
  assert(part?.source);
  assertEquals(JSON.parse(part.source.preview!), raw.content[1]);
  assertEquals(part.source.payload, "Reason");
});
Deno.test("V2 completed result failure is independent of lifecycle and nested calls stay ordered", () => {
  for (
    const metadata of [{ exit: 7 }, { timeout: true }, { signal: "SIGKILL" }, {
      status: "killed",
    }]
  ) {
    const call = mapTool({
      type: "tool",
      id: "shell",
      name: "shell",
      time: { created: 1 },
      state: {
        status: "completed",
        input: { command: "false" },
        metadata: JSON.parse(JSON.stringify(metadata)),
        content: [{ type: "text", text: "output" }],
      },
    });
    assertEquals(call.status, "completed");
    assert(call.failure?.message);
    assertEquals(JSON.parse(call.source!.payload!).state.metadata, metadata);
  }
  const call = mapTool({
    type: "tool",
    id: "execute",
    name: "execute",
    time: { created: 1 },
    state: {
      status: "completed",
      input: { code: "await tools.read({path:'missing'})" },
      metadata: {
        error: true,
        toolCalls: [{
          tool: "read",
          status: "error",
          input: { path: "missing" },
        }, { tool: "other", status: "completed" }],
      },
      content: [{ type: "text", text: "No such file" }],
    },
  });
  assertEquals(call.status, "completed");
  assertEquals(call.failure?.message, "No such file");
  assertEquals(
    call.children?.map((c) => c.tool === "external" ? c.name : c.tool),
    ["read", "other"],
  );
  assertEquals(call.children?.[0].failure?.message, "No such file");
});
Deno.test("V2 settled and cancelled requests retain one distinct row through the injected seam", async () => {
  const { V2RequestRetention } = await import("../request-retention.ts");
  const requests = new V2RequestRetention(), updates: ContentOp[] = [];
  const transcript = new Transcript({
    requests,
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
  transcript.subscriptions(sid, 1);
  try {
    await transcript.event({
      type: "permission.asked",
      data: {
        sessionID: "ses_fixture",
        id: "per_1",
        action: "shell",
        resources: ["pwd"],
      },
    });
    // A durable session event proves the delivered native sequence watermark.
    await transcript.event({
      type: "session.agent.selected",
      created: 1,
      durable: { seq: 100, aggregateID: "ses_fixture" },
      data: { sessionID: "ses_fixture", agent: "build" },
    });
    await transcript.event({
      type: "permission.replied",
      created: 2,
      data: {
        sessionID: "ses_fixture",
        requestID: "per_1",
        reply: "once",
        actor: "other-client",
      },
    });
    await transcript.event({
      type: "form.created",
      data: {
        form: {
          sessionID: "ses_fixture",
          id: "frm_1",
          metadata: { kind: "question" },
          title: "Choose",
          fields: [],
        },
      },
    });
    await transcript.event({
      type: "form.cancelled",
      created: 3,
      data: { sessionID: "ses_fixture", id: "frm_1" },
    });
    const rows = await requests.page(sid, undefined, 10, "sequence");
    assertEquals(rows.length, 2);
    // Ephemeral settlements follow native 100 in delivery order, never at it.
    assertEquals(rows.map((m) => [m.id, m.sourceOrder]), [
      ["request:frm_1", 100 + 2 / 3],
      ["request:per_1", 100.5],
    ]);
    assert(JSON.stringify(rows).includes("other-client"));
    assert(JSON.stringify(rows).includes("Question cancelled"));
    // Outcomes are bookkeeping: inspectable source, never copy content.
    assertEquals(
      rows.flatMap((m) => m.parts).some((p) =>
        p.kind === "external" && p.content
      ),
      false,
    );
    assertEquals(
      rows.every((m) => m.role === "context" && !isRealPrompt(m)),
      true,
    );
    assertEquals(
      updates.filter((op) =>
        op.op === "message.upsert" && op.message.id.startsWith("request:")
      ).length,
      2,
    );
    await transcript.event({
      type: "form.cancelled",
      created: 3,
      data: { sessionID: "ses_fixture", id: "frm_1" },
    });
    assertEquals((await requests.page(sid, undefined, 10)).length, 2);
    await transcript.event({
      type: "form.cancelled",
      data: { sessionID: "global", id: "frm_global" },
    });
    assertEquals((await requests.page("global", undefined, 10)).length, 0);
  } finally {
    await transcript.stop();
  }
  assertEquals((await requests.page(sid, undefined, 10)).length, 0);
});
Deno.test("V2 foreground subagent and migrated task decode prose to blocks without altering raw source", () => {
  const body = "**Result**\n\n| a | b |\n| - | - |\n| c | d |";
  for (
    const [name, output, metadata] of [
      [
        "subagent",
        `<subagent sessionID="ses_child" state="completed">\n${body}\n</subagent>`,
        { sessionID: "ses_child", status: "completed" },
      ],
      [
        "task",
        `<task id="ses_child" state="completed">\n<task_result>\n${body}\n</task_result>\n</task>`,
        { sessionID: "ses_child" },
      ],
    ] as const
  ) {
    const call = mapTool({
      type: "tool",
      id: "call",
      name,
      time: { created: 1, completed: 2 },
      state: {
        status: "completed",
        input: {},
        metadata: { ...metadata },
        content: [{ type: "text", text: output }],
      },
    });
    assertEquals(call.output, output);
    assertEquals(call.outputContent?.kind, "blocks");
    const rendered = JSON.stringify(call.outputContent);
    assert(rendered.includes('"i":"strong"'));
    assert(rendered.includes('"b":"table"'));
    assert(!rendered.includes("<subagent"));
    assert(!rendered.includes("<task"));
  }
});
