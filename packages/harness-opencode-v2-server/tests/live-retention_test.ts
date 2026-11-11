// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Transcript } from "../transcript.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 unfinished text and reasoning precede their first viewer without body reads", async () => {
  const id = "opcv2-ses_unviewed", messageID = "msg_unviewed";
  const transcript = new Transcript({
    client() {
      throw new Error("Unviewed native events must perform no body reads");
    },
    policy: cfg().messages,
    content() {
      throw new Error("Unviewed native source must not publish content");
    },
    diagnostic() {},
    invalidated() {},
  });
  try {
    for (const kind of ["text", "reasoning"] as const) {
      const data = {
        sessionID: "ses_unviewed",
        assistantMessageID: messageID,
        ordinal: 0,
      };
      await transcript.event({ type: `session.${kind}.started`, data });
      await transcript.event({
        type: `session.${kind}.delta`,
        data: { ...data, delta: `Unviewed ${kind}` },
      });
      const snapshot = transcript.buffers.snapshot(
        `${messageID}:${kind}:0`,
        id,
        messageID,
      );
      assertEquals(
        snapshot?.part.stream?.sourceLength,
        `Unviewed ${kind}`.length,
      );
      assertEquals(
        JSON.stringify(snapshot?.part.blocks).includes(`Unviewed ${kind}`),
        true,
      );
    }
    transcript.subscriptions(id, 1);
    const projected = transcript.buffers.overlay({
      id: messageID,
      sessionID: id,
      role: "assistant",
      time: { created: 1 },
      agent: "build",
      model: { provider: "fake", model: "scripted" },
      cost: null,
      tokens: {
        input: null,
        output: null,
        reasoning: null,
        cache: { read: null, write: null },
      },
      interrupted: false,
      parts: [],
    });
    assertEquals(projected.parts.length, 2);
    assertEquals(JSON.stringify(projected).includes("Unviewed text"), true);
    assertEquals(
      JSON.stringify(projected).includes("Unviewed reasoning"),
      true,
    );
    transcript.subscriptions(id, 0);
    await transcript.event({
      type: "session.text.ended",
      data: {
        sessionID: "ses_unviewed",
        assistantMessageID: messageID,
        ordinal: 0,
        text: "Unviewed text",
      },
    });
    assertEquals(transcript.buffers.size, 1);
    await transcript.event({
      type: "session.step.ended",
      data: { sessionID: "ses_unviewed", assistantMessageID: messageID },
    });
    assertEquals(transcript.buffers.size, 0);
  } finally {
    await transcript.stop();
  }
});

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
