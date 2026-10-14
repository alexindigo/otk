// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapMessage } from "@otk/harness-opencode1";
import type { Info } from "@otk/harness-opencode1";
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
