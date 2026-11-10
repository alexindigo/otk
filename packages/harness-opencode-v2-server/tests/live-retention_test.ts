// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Transcript } from "../transcript.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 acquired live source survives viewer replacement without acquiring unviewed bodies", async () => {
  const id = "opcv2-ses_retained",
    message = "msg_retained",
    part = `${message}:text:0`;
  const transcript = new Transcript({
    client() {
      throw new Error("No background native reads");
    },
    policy: cfg().messages,
    content() {},
    diagnostic() {},
    invalidated() {},
  });
  try {
    transcript.subscriptions(id, 1);
    await transcript.event({
      type: "session.step.started",
      data: {
        sessionID: "ses_retained",
        assistantMessageID: message,
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
      },
    });
    await transcript.event({
      type: "session.text.started",
      data: {
        sessionID: "ses_retained",
        assistantMessageID: message,
        ordinal: 0,
      },
    });
    await transcript.event({
      type: "session.text.delta",
      data: {
        sessionID: "ses_retained",
        assistantMessageID: message,
        ordinal: 0,
        delta: "prefix ",
      },
    });
    transcript.subscriptions(id, 0);
    await transcript.event({
      type: "session.text.delta",
      data: {
        sessionID: "ses_retained",
        assistantMessageID: message,
        ordinal: 0,
        delta: "suffix",
      },
    });
    transcript.subscriptions(id, 1);
    assertEquals(
      transcript.buffers.snapshot(part, id, message)?.part.stream?.sourceLength,
      "prefix suffix".length,
    );
    assertEquals(
      JSON.stringify(
        transcript.buffers.snapshot(part, id, message)?.part.blocks,
      ).includes("prefix suffix"),
      true,
    );
    transcript.subscriptions(id, 0);
    await transcript.event({
      type: "session.text.ended",
      data: {
        sessionID: "ses_retained",
        assistantMessageID: message,
        ordinal: 0,
        text: "prefix suffix",
      },
    });
    await transcript.event({
      type: "session.step.ended",
      data: { sessionID: "ses_retained", assistantMessageID: message },
    });
    assertEquals(transcript.buffers.size, 0);
  } finally {
    await transcript.stop();
  }
});
