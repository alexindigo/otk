// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapMessage } from "@otk/harness-opencode1";
import { markdown } from "@otk/content";
import { emptyContent, reduce } from "../../../web/src/state/reduce.ts";
const header = (completed?: number) =>
  mapMessage({
    id: "reply",
    sessionID: "session",
    role: "assistant",
    agent: "build",
    providerID: "fixture",
    modelID: "model",
    time: { created: 1, ...(completed === undefined ? {} : { completed }) },
  });
Deno.test("older buffered live frames cannot replace a newer current-text snapshot", () => {
  const part = {
    kind: "text" as const,
    id: "part",
    synthetic: false,
    blocks: markdown("newer snapshot text"),
    streamVersion: 2,
  };
  const state = {
    ...emptyContent(),
    messages: [{ ...header(), parts: [part] }],
  };
  const stale = {
    op: "part.blocks" as const,
    messageID: "reply",
    partID: "part",
    from: 0,
    blocks: markdown("older frame"),
    streamVersion: 1,
  };
  assertEquals(reduce(state, stale).messages[0].parts[0], part);
  const stalePart = {
    op: "part.upsert" as const,
    messageID: "reply",
    part: { ...part, blocks: markdown("older part"), streamVersion: 1 },
  };
  assertEquals(reduce(state, stalePart).messages[0].parts[0], part);
});
Deno.test("a buffered unfinished header cannot revive a completed snapshot", () => {
  const finished = header(10),
    state = { ...emptyContent(), messages: [finished] };
  assertEquals(
    reduce(state, { op: "message.upsert", message: header() }).messages[0].time,
    finished.time,
  );
});
