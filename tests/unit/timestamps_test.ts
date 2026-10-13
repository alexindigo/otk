// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { mapMessage } from "../../sidecar/adapter/opencode1/map.ts";
import type { Info, RawPart } from "../../sidecar/adapter/opencode1/types.ts";
import { StreamBuffers } from "../../sidecar/content/buffers.ts";
import { emptyContent, reduce } from "../../web/src/state/reduce.ts";
const info: Info = {
  id: "reply",
  sessionID: "session",
  role: "assistant",
  agent: "build",
  providerID: "fixture",
  modelID: "model",
  time: { created: 1000, completed: 2000 },
};
Deno.test("finished clocks use native visible-output end times and exclude bookkeeping", () => {
  const parts: RawPart[] = [
    {
      id: "text",
      sessionID: "session",
      messageID: "reply",
      type: "text",
      text: "done",
      time: { start: 1100, end: 1500 },
    },
    {
      id: "thought",
      sessionID: "session",
      messageID: "reply",
      type: "reasoning",
      text: "thought",
      time: { start: 1200, end: 1700 },
    },
    {
      id: "tool",
      sessionID: "session",
      messageID: "reply",
      type: "tool",
      tool: "bash",
      callID: "call",
      state: {
        status: "completed",
        input: { command: "echo" },
        output: "done",
        time: { start: 1300, end: 1800 },
      },
    },
    {
      id: "step",
      sessionID: "session",
      messageID: "reply",
      type: "step-finish",
      time: { start: 1200, end: 9999 },
    },
  ];
  assertEquals(
    JSON.parse(JSON.stringify(mapMessage(info, parts))).time.lastOutput,
    1800,
  );
  assertEquals(
    JSON.parse(JSON.stringify(mapMessage(info, []))).time.lastOutput,
    2000,
  );
  assertEquals(
    JSON.parse(
      JSON.stringify(mapMessage({ ...info, time: { created: 1000 } }, [])),
    ).time.lastOutput,
    1000,
  );
});
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
    const live = mapMessage({ ...info, time: { created: 1000 } });
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
Deno.test("a finished native clock replaces the later live observation and ignores subsequent stale chunks", () => {
  const live = mapMessage({ ...info, time: { created: 1000 } }, [], 3100);
  const finished = mapMessage(info, [], 1800);
  let state = { ...emptyContent(), messages: [live] };
  state = reduce(state, { op: "message.upsert", message: finished });
  assertEquals(
    JSON.parse(JSON.stringify(state.messages[0])).time.lastOutput,
    1800,
  );
  state = reduce(state, {
    op: "part.blocks",
    messageID: "reply",
    partID: "unknown",
    from: 0,
    blocks: [],
    lastOutput: 5000,
    streamVersion: 1,
  });
  assertEquals(
    JSON.parse(JSON.stringify(state.messages[0])).time.lastOutput,
    1800,
  );
});
Deno.test("live mapping accepts the sidecar-observed RAM clock without giving user messages a clock", () => {
  const live = Reflect.apply(mapMessage, undefined, [
    { ...info, time: { created: 1000 } },
    [],
    3100,
  ]);
  assert(live.role === "assistant");
  assertEquals(live.time.lastOutput, 3100);
  const user = Reflect.apply(mapMessage, undefined, [
    { ...info, role: "user", time: { created: 1000 } },
    [],
    3100,
  ]);
  assertEquals("lastOutput" in user.time, false);
});
