// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Message } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";

Deno.test("header-only context does not acquire a record disclosure before prompt classification", () => {
  const projection = createTranscriptProjection();
  const header: Message = {
    id: "native-prompt",
    sessionID: "session",
    role: "context",
    time: { created: 1 },
    parts: [],
    source: { kind: "native/message", ref: "opaque-header" },
  };
  projection.apply({ op: "message.upsert", message: header });
  // Native V1 headers arrive before the parts that establish prompt identity.
  // Keep the source row, but never offer a disclosure for a nonexistent body.
  assertEquals(projection.state.records.keys, [header.id]);
  assertEquals(projection.state.records.owners[header.id], header.id);
  assertEquals(Object.keys(projection.state.records.groups), []);
  assertEquals(projection.state.messagesByID[header.id].source, header.source);
  projection.apply({
    op: "message.upsert",
    message: {
      ...header,
      role: "user",
      parts: [{
        id: "prompt-text",
        kind: "text",
        blocks: [],
        synthetic: false,
      }],
    },
  });
  assertEquals(projection.state.records.keys, [header.id]);
  assertEquals(Object.keys(projection.state.records.groups), []);
});

Deno.test("record admission belongs to the complete context interval, not each empty row", () => {
  const projection = createTranscriptProjection();
  const header = (id: string, created: number): Message => ({
    id,
    sessionID: "session",
    role: "context",
    time: { created },
    parts: [],
  });
  const first = header("first", 1), last = header("last", 2);
  projection.replace([first, last]);
  assertEquals(projection.state.records.keys, [first.id, last.id]);
  assertEquals(Object.keys(projection.state.records.groups), []);
  projection.apply({
    op: "part.upsert",
    messageID: last.id,
    part: { id: "body", kind: "external", name: "native/context" },
  });
  assertEquals(projection.state.records.keys, ["activity:first"]);
  assertEquals(projection.state.records.groups["activity:first"].members, [
    first.id,
    last.id,
  ]);
  assertEquals(projection.state.records.groups["activity:first"].breakouts, [
    first.id,
    last.id,
  ]);
  projection.apply({ op: "part.remove", messageID: last.id, partID: "body" });
  assertEquals(projection.state.records.keys, [first.id, last.id]);
  assertEquals(Object.keys(projection.state.records.groups), []);
});

Deno.test("header-only context joins record ownership only when content is admitted", () => {
  const projection = createTranscriptProjection();
  const header: Message = {
    id: "native-record",
    sessionID: "session",
    role: "context",
    time: { created: 1 },
    parts: [],
  };
  projection.apply({ op: "message.upsert", message: header });
  assertEquals(Object.keys(projection.state.records.groups), []);
  projection.apply({
    op: "part.upsert",
    messageID: header.id,
    part: { id: "declared-content", kind: "external", name: "native/context" },
  });
  const record = projection.state.records;
  assertEquals(record.groups[record.keys[0]].members, [header.id]);
  assertEquals(record.parents[header.id], [record.keys[0]]);
  projection.apply({
    op: "part.remove",
    messageID: header.id,
    partID: "declared-content",
  });
  assertEquals(projection.state.records.keys, [header.id]);
  assertEquals(Object.keys(projection.state.records.groups), []);
});
