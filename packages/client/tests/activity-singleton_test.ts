// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTranscriptProjection } from "../mod.ts";
import type { Message } from "@otk/protocol";

function record(id: string, created = 1000): Message {
  return {
    id,
    sessionID: "session",
    role: "context",
    time: { created },
    parts: [{
      kind: "external",
      id: `part-${id}`,
      name: "example/run",
      activity: {
        title: "Run finished",
        kindLabel: "Run",
        layout: "row",
        category: "record",
        tone: "normal",
        summary: { kind: "run", noun: "run", plural: "runs" },
      },
    }],
  };
}
Deno.test("one record owns its row and later appends never replace that row with a span", () => {
  const p = createTranscriptProjection();
  p.replace([record("r1")]);
  assertEquals(p.state.records.keys, ["r1"]);
  assertEquals(p.state.records.groups, Object.create(null));
  assertEquals(p.state.records.owners.r1, "r1");
  p.apply({ op: "message.upsert", message: record("r2") });
  assertEquals(p.state.records.keys, ["r1", "r2"]);
  assertEquals(p.state.records.owners.r1, "r1");
  p.replace(p.messages());
  assertEquals(p.state.records.keys, ["r1", "r2"]);
});
Deno.test("span clocks carry one time when their endpoints are equal", () => {
  const p = createTranscriptProjection();
  p.replace([record("r1"), record("r2")]);
  assertEquals<unknown>(p.state.records.groups["activity:r1"].time, {
    first: 1000,
  });
  p.apply({ op: "message.upsert", message: record("r2", 2000) });
  assertEquals(p.state.records.groups["activity:r1"].time, {
    first: 1000,
    last: 2000,
  });
});
