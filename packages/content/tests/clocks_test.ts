// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { StreamBuffers } from "@otk/content";
import type { AssistantMessage } from "@otk/protocol";

Deno.test("RAM reply clocks survive unseen chunks, derive only retained native ends and cannot revive after completion", () => {
  const buffers = new StreamBuffers(), original = Date.now;
  let now = 1100;
  try {
    Date.now = () => now;
    buffers.upsert("session", "reply", {
      kind: "text",
      id: "text",
      synthetic: false,
      blocks: [],
    }, "first");
    now = 1200;
    buffers.append("text", " second", () => {});
    assertEquals(buffers.outputTime("reply"), 1200);
    const live: AssistantMessage = {
      id: "reply",
      sessionID: "session",
      role: "assistant",
      agent: "build",
      time: { created: 1000 },
      model: { provider: "fixture", model: "model" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    };
    const snapshot = buffers.overlay(live);
    assertEquals(JSON.parse(JSON.stringify(snapshot)).time.lastOutput, 1200);
    buffers.observeOutput("session", "reply", 1300, 1150, "text");
    buffers.observeOutput("session", "reply", 1400, 1140, "tool");
    assertEquals(buffers.outputEnd("reply"), 1150);
    buffers.forgetPart("reply", "text");
    assertEquals(buffers.outputEnd("reply"), 1140);
    buffers.complete("reply", () => {});
    assertEquals(buffers.outputTime("reply"), undefined);
    assertEquals(buffers.outputEnd("reply"), undefined);
    assertEquals(
      buffers.observeOutput("session", "reply", 1500, 1600, "tool"),
      undefined,
    );
  } finally {
    buffers.stop();
    Date.now = original;
  }
});
for (const removal of ["message", "session", "reset", "stop"] as const) {
  Deno.test(`output-only RAM clocks are released on ${removal}`, () => {
    const buffers = new StreamBuffers();
    buffers.beginReply("session", "reply");
    buffers.observeOutput("session", "reply", 4300, 4200, "tool");
    if (removal === "message") buffers.removeMessage("reply");
    if (removal === "session") buffers.removeSession("session");
    if (removal === "reset") buffers.reset();
    if (removal === "stop") buffers.stop();
    assertEquals(buffers.outputTime("reply"), undefined);
    assertEquals(buffers.outputEnd("reply"), undefined);
    buffers.stop();
  });
}
