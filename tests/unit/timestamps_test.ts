// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { mapMessage } from "@otk/harness-opencode1";
import type { Info, RawPart } from "@otk/harness-opencode1";
import { emptyContent, reduce } from "@otk/client";
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
