// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { mapMessage } from "../map.ts";
import type { Info } from "../types.ts";

const raw: Info = {
  id: "failed",
  sessionID: "s",
  role: "assistant",
  agent: "build",
  time: { created: 1000 },
  error: { name: "MessageAbortedError", data: { message: "Interrupted" } },
};
Deno.test("V1 aborted calls use the native completion or last part, never observed now", () => {
  const completed = mapMessage({
    ...raw,
    time: { created: 1000, completed: 1500 },
  });
  assert(completed.role === "assistant");
  assertEquals(completed.outcomeTime, {
    state: "known",
    at: 1500,
    source: "completed",
  });
  const part = mapMessage(raw, [{
    id: "part",
    sessionID: "s",
    messageID: "failed",
    type: "reasoning",
    text: "thinking",
    time: { start: 1100, end: 1400 },
  }], 9999);
  assert(part.role === "assistant");
  assertEquals(part.outcomeTime, { state: "known", at: 1400, source: "part" });
  const unknown = mapMessage(raw, [], 9999);
  assert(unknown.role === "assistant");
  assertEquals(unknown.outcomeTime?.state, "unknown");
});
