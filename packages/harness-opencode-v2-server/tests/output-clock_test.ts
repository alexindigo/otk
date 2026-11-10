// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ContentOp } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import { mapMessage } from "../map.ts";
import { cfg } from "../../../tests/support/config.ts";

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
