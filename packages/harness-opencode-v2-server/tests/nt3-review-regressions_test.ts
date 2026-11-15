// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createTranscriptProjection } from "@otk/client";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";
import type { NativeMessage } from "../messages.ts";
import { factsFrom, scalarMessage } from "../transcript-reads.ts";
import { cfg } from "../../../tests/support/config.ts";
import { mapMessage } from "../classify.ts";

const sid = "opcv2-ses_fixture";
function fixture(status = "completed") {
  const old = {
    id: "msg_old",
    type: "compaction",
    status,
    reason: "manual",
    summary: "Old summary",
    time: { created: 1 },
  } as NativeMessage;
  const projection = createTranscriptProjection();
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
    message: { list: () => Promise.resolve({ data: [old], cursor: {} }) },
  };
  const client = {
    service: { version: "2.2.6" },
    read: <T>(run: (value: typeof api) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const transcript = new Transcript({
    client: () => client,
    policy: cfg().messages,
    facts: () => Promise.resolve(factsFrom([scalarMessage(old, 1)], [old.id])),
    sequence: () => Promise.resolve(8),
    content: (_id, op) => projection.apply(op),
    invalidated() {},
    diagnostic(error) {
      throw error;
    },
  });
  transcript.subscriptions(sid, 1);
  const event = (
    type: string,
    created: number,
    data: Record<string, unknown>,
    id = `evt_${type}_${created}`,
  ) =>
    transcript.event({
      type,
      id,
      created,
      data: { sessionID: "ses_fixture", ...data },
    });
  const start = (id: string, created: number) =>
    event("session.step.started", created, {
      assistantMessageID: id,
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
    });
  const retry = (id: string, created: number) =>
    event("session.retry.scheduled", created, {
      assistantMessageID: id,
      attempt: 2,
      at: 30000,
      error: { type: "provider", message: "Retry cause" },
    });
  const hasRetry = (id: string) =>
    projection.messages().find((m) => m.id === id)?.parts.some((p) =>
      p.id === `${id}:retry`
    );
  return { transcript, projection, event, start, retry, hasRetry };
}

Deno.test("NT3 stale step rejection preserves the active retry and retained history", async () => {
  const f = fixture();
  try {
    await f.start("msg_reply", 10);
    await f.retry("msg_reply", 11);
    assert(f.hasRetry("msg_reply"));
    await f.start("msg_reply", 5);
    assert(f.hasRetry("msg_reply"));
    assert(f.projection.messages().some((m) => m.id.startsWith("record:")));
  } finally {
    await f.transcript.stop();
  }
});
Deno.test("NT3 admitted step retires only its own assistant retry", async () => {
  const f = fixture();
  try {
    await f.start("msg_one", 10);
    await f.retry("msg_one", 11);
    await f.start("msg_two", 12);
    await f.retry("msg_two", 13);
    assert(f.hasRetry("msg_one"));
    assert(f.hasRetry("msg_two"));
    await f.start("msg_two", 14);
    assertEquals(f.hasRetry("msg_two"), false);
    assert(f.hasRetry("msg_one"));
  } finally {
    await f.transcript.stop();
  }
});
Deno.test("NT3 malformed step admission preserves retry while execution settlement clears the session", async () => {
  const f = fixture();
  try {
    await f.start("msg_one", 10);
    await f.retry("msg_one", 11);
    await f.event("session.step.started", 12, {
      assistantMessageID: "msg_one",
      agent: "build",
    });
    assert(f.hasRetry("msg_one"));
    await f.event("session.execution.failed", 13, {
      error: { type: "provider", message: "Stopped" },
    });
    assertEquals(f.hasRetry("msg_one"), false);
    assert(f.projection.messages().some((m) => m.id.startsWith("record:")));
  } finally {
    await f.transcript.stop();
  }
});
for (const phase of ["delta", "ended"] as const) {
  Deno.test(`NT3 historical compaction mapping cannot take ownership of active ${phase}`, async () => {
    const f = fixture();
    try {
      await f.event("session.compaction.started", 10, {
        reason: "manual",
        inputID: "msg_current",
      });
      const page = await f.transcript.page(sid);
      assertEquals(page.items[0].id, "msg_old");
      await f.event(`session.compaction.${phase}`, 11, {
        reason: "manual",
        text: "Current summary",
      });
      const current = f.projection.messages().find((m) =>
        m.id === "msg_current"
      )!;
      assert(JSON.stringify(current).includes("Current summary"));
      if (phase === "ended") {
        assertEquals(f.projection.messages().map((m) => m.id), ["msg_current"]);
        const part = current.parts[0];
        assert(part.kind === "external");
        assertEquals(part.activity?.state?.key, "completed");
      }
    } finally {
      await f.transcript.stop();
    }
  });
}
Deno.test("NT3 a snapshot may seed an absent active compaction and terminal-only records stay distinct", async () => {
  const f = fixture("running");
  try {
    f.projection.replace((await f.transcript.page(sid)).items);
    await f.event("session.compaction.delta", 10, { text: " appended" });
    assert(
      JSON.stringify(f.projection.messages()[0]).includes(
        "Old summary appended",
      ),
    );
    await f.event("session.compaction.ended", 11, {
      text: "Completed seeded summary",
    });
    const ended = f.projection.messages()[0].parts[0];
    assert(ended.kind === "external");
    assertEquals(ended.activity?.state?.key, "completed");
    await f.event("session.compaction.ended", 12, {
      text: "Independent terminal summary",
    }, "evt_independent");
    assertEquals(f.projection.messages().map((m) => m.id), [
      "msg_old",
      "msg_independent",
    ]);
  } finally {
    await f.transcript.stop();
  }
});
Deno.test("NT3 completed boundary matcher accepts every declared completion dialect", () => {
  const source = Deno.readTextFileSync(
    new URL("../../../tests/browser/pages/transcript.ts", import.meta.url),
  );
  const declared = source.match(/completed: \/(\^Session compacted[^\n]+)\/,/);
  assert(declared);
  const pattern = new RegExp(declared[1]);
  for (const native of [undefined, { messages: [] }]) {
    for (
      const tokens of [undefined, {
        input: 20,
        output: 3,
        reasoning: 2,
        cache: { read: 5, write: 0 },
      }]
    ) {
      const message = mapMessage(
        {
          id: "msg_complete",
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "Summary",
          native,
          tokens,
          time: { created: 1 },
        } as NativeMessage,
        sid,
        { order: 1 },
      );
      const part = message.parts[0];
      assert(part.kind === "external");
      assert(pattern.test(part.activity!.title), part.activity!.title);
    }
  }
});
