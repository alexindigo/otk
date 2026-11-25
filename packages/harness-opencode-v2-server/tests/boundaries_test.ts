// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { deriveInboxMessage, mapMessage } from "../classify.ts";
import type { NativeMessage } from "../messages.ts";
import type { ExternalPart } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";
import { createTranscriptProjection } from "@otk/client";
import { cfg } from "../../../tests/support/config.ts";
import { eventMessage } from "../messages.ts";
import { requestFailureFacts } from "../request-failure.ts";
import { mapMessage as projectNative } from "../map.ts";
import { referenced } from "../native-source.ts";

const sid = "opcv2-ses_fixture";
/** Only the named durable records can be read; any other read is a defect. */
function liveFixture(records: Record<string, NativeMessage> = {}) {
  const projection = createTranscriptProjection();
  const api = {
    session: {
      message: {
        get: ({ messageID }: { messageID: string }) =>
          records[messageID]
            ? Promise.resolve(records[messageID])
            : Promise.reject(new Error("No native body read permitted")),
      },
    },
  };
  const transcript = new Transcript({
    client: () =>
      ({
        read: (run: (value: typeof api) => Promise<unknown>) => run(api),
        failureFacts: requestFailureFacts,
      }) as unknown as V2Client,
    policy: cfg().messages,
    sequence: () => Promise.resolve(8),
    facts: (input) =>
      Promise.resolve({
        source: "sql:fixture",
        metadata: { boundaries: [] },
        contexts: Object.fromEntries(
          input.messages.map((id) => [id, { order: 8 }]),
        ),
      }),
    content: (_id, op) => projection.apply(op),
    diagnostic(error) {
      throw error;
    },
    invalidated() {},
  });
  transcript.subscriptions(sid, 1);
  return { transcript, projection };
}
Deno.test("NT3 live terminal-only compaction, streamed lifecycle and selection records keep native IDs", async () => {
  const { transcript, projection } = liveFixture();
  try {
    for (
      const event of [
        {
          type: "session.compaction.ended",
          id: "evt_terminal",
          data: {
            reason: "manual",
            text: "Terminal only",
            tokens: {
              input: 20,
              output: 3,
              reasoning: 2,
              cache: { read: 5, write: 0 },
            },
          },
        },
        {
          type: "session.compaction.started",
          id: "evt_start",
          data: { reason: "auto", inputID: "msg_queued" },
        },
        {
          type: "session.compaction.delta",
          id: "evt_delta",
          data: { text: "**streamed**" },
        },
        {
          type: "session.compaction.ended",
          id: "evt_end",
          data: {
            reason: "auto",
            text: "**summary**",
            model: { providerID: "fixture", id: "model" },
            native: { messages: [] },
          },
        },
        {
          type: "session.compaction.ended",
          id: "evt_later",
          data: { reason: "manual", text: "Another terminal only" },
        },
        {
          type: "session.model.selected",
          id: "evt_model",
          data: {
            model: { providerID: "fixture", id: "model", variant: "high" },
            previous: { providerID: "fixture", id: "model" },
          },
        },
        {
          type: "session.execution.failed",
          id: "evt_idle",
          data: {
            error: {
              type: "provider",
              message: "The usage limit has been reached",
            },
          },
        },
      ]
    ) {
      // The adapter materializes the canonical retained failure before routing
      // the native lifecycle edge. That edge must not add another idle record.
      await transcript.executionFailure({
        ...event,
        created: 1,
        data: { ...event.data, sessionID: "ses_fixture" },
      });
      await transcript.event({
        ...event,
        created: 1,
        data: { ...event.data, sessionID: "ses_fixture" },
      });
    }
    assertEquals(projection.messages().map((m) => m.id), [
      "msg_terminal",
      "msg_queued",
      "msg_later",
      "msg_model",
      "request:failure:execution:evt_idle",
    ]);
    const titles = projection.messages().flatMap((m) =>
      m.parts.flatMap((p) => p.kind === "external" ? [p.activity?.title] : [])
    );
    assert(titles.includes("Session compacted - 25 in - 5 out"));
    assert(titles.includes("Session compacted by provider"));
    assert(titles.includes("Switched variant to high"));
    assertEquals(
      eventMessage({
        type: "session.execution.interrupted",
        id: "evt_shutdown",
        data: { reason: "shutdown" },
      }),
      undefined,
    );
    assertEquals(
      projection.messages().find((m) => m.id === "msg_queued")?.parts.length,
      1,
    );
  } finally {
    await transcript.stop();
  }
});
Deno.test("NT3 compaction event sources equal native records through every lifecycle", async () => {
  const variants: NativeMessage["metadata"][] = [
    undefined,
    {},
    { owner: "native" },
  ];
  for (const metadata of variants) {
    for (const started of [false, true]) {
      for (const failed of [false, true]) {
        const { transcript, projection } = liveFixture();
        const tokens = {
          input: 20,
          output: 3,
          reasoning: 2,
          cache: { read: 5, write: 0 },
        };
        try {
          if (started) {
            await transcript.event({
              type: "session.compaction.started",
              id: "evt_compaction",
              created: 1,
              metadata,
              data: { sessionID: "ses_fixture", reason: "manual" },
            });
            await transcript.event({
              type: "session.compaction.delta",
              id: "evt_delta",
              created: 2,
              data: { sessionID: "ses_fixture", text: "partial summary" },
            });
          }
          const error = { type: "aborted", message: "Interrupted" },
            model = { providerID: "fixture", id: "model" },
            native = { messages: [] },
            summary = "complete summary";
          const terminal = {
            ...(failed ? { error } : { model, native, text: summary }),
            cost: 0,
            tokens,
          };
          await transcript.event({
            type: `session.compaction.${failed ? "failed" : "ended"}`,
            id: started ? "evt_terminal" : "evt_compaction",
            created: 3,
            metadata,
            data: { sessionID: "ses_fixture", reason: "manual", ...terminal },
          });
          const raw = {
            id: "msg_compaction",
            type: "compaction",
            status: failed ? "failed" : "completed",
            reason: "manual",
            metadata,
            time: { created: started ? 1 : 3 },
            cost: terminal.cost,
            tokens,
            ...(failed ? { error } : { model, native, summary }),
          } as NativeMessage;
          assertEquals(
            projection.messages(),
            [
              referenced(
                projectNative(raw, sid, { order: started ? 3 : 1 }),
                raw.id,
              ),
            ],
          );
        } finally {
          await transcript.stop();
        }
      }
    }
  }
});
Deno.test("NT3 retry history and unknown delivered records survive repeat delivery, source stays on demand, active retry ends", async () => {
  const { transcript, projection } = liveFixture();
  try {
    await transcript.event({
      type: "session.step.started",
      id: "evt_step",
      created: 1,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: "msg_reply",
        agent: "build",
        model: { providerID: "fixture", id: "model" },
      },
    });
    const retry = {
      type: "session.retry.scheduled",
      id: "evt_retry",
      created: 2,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: "msg_reply",
        attempt: 2,
        at: 10000,
        error: { type: "provider", message: "Try again later" },
      },
    };
    await transcript.event(retry);
    await transcript.event(retry);
    const unknown = {
      type: "session.future.lifecycle",
      id: "evt_future",
      created: 3,
      data: { sessionID: "ses_fixture", detail: "kept" },
    };
    await transcript.event(unknown);
    assertEquals(
      projection.messages().filter((m) => m.id === "record:evt_retry").length,
      1,
    );
    const history = projection.messages().find((m) =>
      m.id === "record:evt_retry"
    )!;
    assertEquals(history.source?.preview, undefined);
    assertEquals(history.source?.payload, undefined);
    const source = await transcript.source(
      sid,
      history.source!.ref!,
      new AbortController().signal,
    );
    assert(source.preview.includes("Try again later"));
    assert(
      (await transcript.requests.page(sid, undefined, 10)).some((m) =>
        m.id === "record:evt_future"
      ),
    );
    const active = projection.messages().find((m) => m.id === "msg_reply")!;
    assert(
      active.parts.some((p) =>
        p.kind === "external" && p.activity?.state?.facts.active === true
      ),
    );
    await transcript.event({
      type: "session.step.started",
      id: "evt_resume",
      created: 4,
      data: {
        sessionID: "ses_fixture",
        assistantMessageID: "msg_reply",
        agent: "build",
        model: { providerID: "fixture", id: "model" },
      },
    });
    assert(
      !projection.messages().find((m) => m.id === "msg_reply")!.parts.some((
        p,
      ) => p.id === "msg_reply:retry"),
    );
    assert(projection.messages().some((m) => m.id === "record:evt_retry"));
    await transcript.deleted(sid);
    assertEquals(await transcript.requests.page(sid, undefined, 10), []);
  } finally {
    await transcript.stop();
  }
});
function mapped(value: Record<string, unknown>) {
  return mapMessage(
    { id: "msg_fixture", time: { created: 1 }, ...value } as NativeMessage,
    sid,
    { order: 3 },
  );
}
function activity(value: Record<string, unknown>) {
  const message = mapped(value);
  assertEquals(message.role, "context");
  const part = message.parts[0] as ExternalPart;
  assertEquals(part.kind, "external");
  assert(part.activity);
  return part;
}
Deno.test("NT3 compaction lifecycle is plugin-owned, usage is request usage, and body is declared content", () => {
  const base = {
    type: "compaction",
    reason: "manual",
    summary: "**Summary**",
    tokens: {
      input: 400000,
      output: 2800,
      reasoning: 100,
      cache: { read: 39000, write: 700 },
    },
  };
  for (
    const [extra, title, active, tone] of [
      [{ status: "running" }, "Session compaction started", true, "normal"],
      [
        { status: "completed" },
        "Session compacted - 439.7K in - 2.9K out",
        false,
        "normal",
      ],
      [
        { status: "completed", native: { messages: [] } },
        "Session compacted by provider - 439.7K in - 2.9K out",
        false,
        "normal",
      ],
      [
        { status: "failed", error: { type: "aborted", message: "Stopped" } },
        "Session compaction cancelled - 439.7K in - 2.9K out",
        false,
        "normal",
      ],
      [
        {
          status: "failed",
          error: { type: "compaction.interrupted", message: "Interrupted" },
        },
        "Session compaction interrupted - 439.7K in - 2.9K out",
        false,
        "normal",
      ],
      [
        {
          status: "failed",
          error: {
            type: "provider",
            message: "The usage limit has been reached",
          },
        },
        "Session compaction failed - 439.7K in - 2.9K out",
        false,
        "error",
      ],
    ] as const
  ) {
    const p = activity({ ...base, ...extra });
    assertEquals(p.activity?.title, title);
    assertEquals(p.activity?.layout, "boundary");
    assertEquals(p.activity?.category, "compaction");
    assertEquals(p.activity?.state?.facts, { active, terminal: !active });
    assertEquals(p.activity?.tone, tone);
    // Only a real failure keeps its cause on the row.
    assertEquals(
      p.activity?.detail,
      tone === "error" ? "The usage limit has been reached" : undefined,
    );
    assertEquals(p.content, extra.status === "failed" ? undefined : true);
    assert(p.activity?.body?.length);
  }
  for (
    const tokens of [undefined, {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }]
  ) {
    assertEquals(
      activity({ ...base, tokens, status: "completed" }).activity?.title,
      "Session compacted",
    );
  }
});
Deno.test("NT3 active retry is not historical bookkeeping and its cause stays visible", () => {
  const message = mapped({
    type: "assistant",
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    content: [],
    retry: {
      attempt: 2,
      at: 10000,
      error: { type: "provider", message: "Try again later" },
    },
  });
  const part = message.parts.find((p) =>
    p.kind === "external" && p.name === "opencode-v2/active-retry"
  ) as ExternalPart;
  assertEquals(part.activity?.detail, "Try again later");
  assertEquals(part.activity?.state?.facts, { active: true, terminal: false });
  assertEquals(part.content, undefined);
});
Deno.test("NT3 queued compaction keeps the inbox identity and does not invent an active start", () => {
  const message = deriveInboxMessage(
    "msg_queue",
    { type: "compaction", payload: {}, delivery: "queue" },
    1,
    sid,
    { order: 3 },
  );
  const p = message.parts[0] as ExternalPart;
  assertEquals(message.id, "msg_queue");
  assertEquals(p.activity?.title, "Session compaction queued");
  assertEquals(p.activity?.state?.facts, { active: false, terminal: false });
  assertEquals(p.content, undefined);
});
Deno.test("NT3 switch boundaries preserve previous and current values, including variant-only and default", () => {
  const model = { providerID: "fixture", id: "model", variant: "high" };
  for (
    const [value, title] of [
      [{ type: "model-switched", model }, "Switched to model - high"],
      [{
        type: "model-switched",
        model,
        previous: { ...model, variant: "low" },
      }, "Switched variant to high"],
      [{
        type: "model-switched",
        model: { ...model, variant: undefined },
        previous: model,
      }, "Switched variant to Default"],
      [
        { type: "agent-switched", agent: "plan", previous: "build" },
        "Switched agent to plan",
      ],
      [{
        type: "location-switched",
        location: { directory: "/repo/destination" },
        previous: { location: { directory: "/repo" } },
      }, "Moved to /repo/destination"],
    ] as const
  ) {
    const p = activity(value);
    assertEquals(p.activity?.title, title);
    assertEquals(p.activity?.layout, "boundary");
    assertEquals(p.content, undefined);
    assert(
      p.activity?.parameters?.some((p) => p.key === "previous") ||
        !("previous" in value),
    );
  }
});
Deno.test("NT3 idle-only provider errors and native interruption types remain visible without assistant prose", () => {
  const p = activity({
    type: "idle",
    outcome: "failed",
    error: { type: "provider", message: "The usage limit has been reached" },
  });
  assertEquals(p.activity?.tone, "error");
  assertEquals(p.activity?.detail, "The usage limit has been reached");
  assertEquals(p.content, undefined);
  for (
    const type of ["aborted", "provider.interrupted", "RequestAbortedError"]
  ) {
    const message = mapped({
      type: "assistant",
      agent: "build",
      model: { providerID: "fixture", id: "model" },
      content: [],
      error: { type, message: "Step interrupted" },
    });
    assert(message.role === "assistant" && message.interrupted);
    const boundary = message.parts.find((p) =>
      p.kind === "external" && p.activity?.layout === "boundary"
    ) as ExternalPart;
    assertEquals(boundary.activity?.title, "Interrupted");
    assert(
      JSON.stringify(boundary.activity?.body).includes("Step interrupted"),
    );
  }
});
Deno.test("NT3 queued move and compaction delivery retire the queued item without a native read", async () => {
  const at = (path: string) => ({ directory: path });
  // The move records are durable native messages derived from each event.
  const moved = (id: string, to: string, from: string) =>
    ({
      id,
      type: "location-switched",
      location: at(to),
      projectID: "prj",
      previous: { location: at(from), projectID: "prj", subpath: "" },
      time: { created: 1 },
    }) as unknown as NativeMessage;
  const { transcript, projection } = liveFixture({
    msg_moved1: moved("msg_moved1", "/next", "/start"),
    msg_moved2: moved("msg_moved2", "/last", "/next"),
  });
  try {
    for (
      const event of [
        {
          type: "session.inbox.enqueued",
          id: "evt_q1",
          data: {
            inboxID: "msg_move1",
            item: {
              type: "move",
              delivery: "queue",
              payload: { location: at("/next"), projectID: "prj_next" },
            },
          },
        },
        {
          type: "session.inbox.enqueued",
          id: "evt_q2",
          data: {
            inboxID: "msg_compact",
            item: { type: "compaction", delivery: "queue", payload: {} },
          },
        },
        // Native publishes delivery for the inbox ID; the move record then
        // comes from its own event with a new ID (runner/llm.ts).
        {
          type: "session.inbox.delivered",
          id: "evt_d1",
          data: { inboxID: "msg_move1" },
        },
        {
          type: "session.moved",
          id: "evt_moved1",
          data: { location: at("/next"), projectID: "prj_next" },
        },
        {
          type: "session.inbox.delivered",
          id: "evt_d2",
          data: { inboxID: "msg_compact" },
        },
        {
          type: "session.compaction.started",
          id: "evt_cstart",
          data: { reason: "manual", inputID: "msg_compact" },
        },
        {
          type: "session.inbox.enqueued",
          id: "evt_q3",
          data: {
            inboxID: "msg_move2",
            item: {
              type: "move",
              delivery: "queue",
              payload: { location: at("/last"), projectID: "prj_last" },
            },
          },
        },
        {
          type: "session.inbox.delivered",
          id: "evt_d3",
          data: { inboxID: "msg_move2" },
        },
        {
          type: "session.moved",
          id: "evt_moved2",
          data: { location: at("/last"), projectID: "prj_last" },
        },
      ]
    ) {
      await transcript.event({
        ...event,
        created: 1,
        data: { ...event.data, sessionID: "ses_fixture" },
      });
    }
    const messages = projection.messages();
    assertEquals(messages.map((m) => m.id), [
      "msg_moved1",
      "msg_compact",
      "msg_moved2",
    ]);
    const titles = messages.flatMap((m) =>
      m.parts.flatMap((p) => p.kind === "external" ? [p.activity?.title] : [])
    );
    assertEquals(titles, [
      "Moved to /next",
      "Session compaction started",
      "Moved to /last",
    ]);
    // Repeated moves keep each record's own previous location.
    const previous = messages.flatMap((m) =>
      m.parts.flatMap((p) =>
        p.kind === "external"
          ? (p.activity?.parameters ?? []).filter((x) => x.key === "previous")
            .map((x) => x.value)
          : []
      )
    );
    assertEquals(previous, [
      JSON.stringify({ location: at("/start"), projectID: "prj", subpath: "" }),
      JSON.stringify({ location: at("/next"), projectID: "prj", subpath: "" }),
    ]);
    // An unobserved queued item still reads; a failure that does not prove
    // absence is not swallowed.
    await assertRejects(
      () =>
        transcript.event({
          type: "session.inbox.delivered",
          id: "evt_d4",
          created: 1,
          data: { sessionID: "ses_fixture", inboxID: "msg_unobserved" },
        }),
      Error,
      "No native body read permitted",
    );
  } finally {
    await transcript.stop();
  }
});
