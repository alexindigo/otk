// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { AssistantMessage, Part, StreamStamp } from "@otk/protocol";
import { createTranscriptProjection } from "../transcript-projection.ts";

const part = (text: string, stream?: StreamStamp): Part => ({
  id: "part",
  kind: "text",
  synthetic: false,
  blocks: [{ b: "paragraph", inline: [{ i: "text", text }] }],
  ...(stream ? { stream } : {}),
});
const message = (text: string): AssistantMessage => ({
  id: "message",
  sessionID: "tstv1-session",
  role: "assistant",
  agent: "build",
  model: { provider: "test", model: "test" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  time: { created: 1 },
  parts: [part(text)],
});
const blocks = (value: Part) =>
  value.kind === "text" || value.kind === "reasoning" ? value.blocks : [];

Deno.test("unfinished snapshots and replacements retain last-good source until newer content or terminal authority", () => {
  const projection = createTranscriptProjection();
  const original = message("The last-good streamed text.");
  projection.replace([original]);
  for (const text of ["", "The last-good"]) {
    projection.replace([message(text)]);
    assertEquals(
      blocks(projection.messages()[0].parts[0]),
      blocks(original.parts[0]),
    );
    projection.apply({
      op: "part.upsert",
      messageID: original.id,
      part: part(text, {
        epoch: "new",
        generation: 2,
        version: 1,
        mode: "replace",
      }),
    });
    const retained = projection.messages()[0].parts[0];
    assertEquals(blocks(retained), blocks(original.parts[0]));
    if (retained.kind === "text") {
      assertEquals(retained.stream?.mode, "replace");
    }
  }
  projection.apply({
    op: "part.upsert",
    messageID: original.id,
    part: part("The last-good streamed text. A new chunk.", {
      epoch: "new",
      generation: 3,
      version: 2,
      mode: "appendable",
    }),
  });
  assertEquals(
    blocks(projection.messages()[0].parts[0]),
    blocks(part("The last-good streamed text. A new chunk.")),
  );
  projection.replace([{ ...message(""), parts: [] }]);
  assertEquals(
    blocks(projection.messages()[0].parts[0]),
    blocks(part("The last-good streamed text. A new chunk.")),
  );
  projection.apply({
    op: "part.remove",
    messageID: original.id,
    partID: "part",
  });
  projection.replace([message("")]);
  assertEquals(projection.messages()[0].parts, message("").parts);
  projection.replace([original]);
  const terminal = { ...message("Final"), time: { created: 1, completed: 2 } };
  projection.replace([terminal]);
  assertEquals(projection.messages()[0].parts, terminal.parts);
  projection.apply({ op: "message.remove", messageID: original.id });
  projection.replace([message("")]);
  assertEquals(projection.messages()[0].parts, message("").parts);
});

Deno.test("source coverage accepts longer native Markdown even when its rendered text shrinks", () => {
  const projection = createTranscriptProjection();
  const before = {
    ...message("**word"),
    parts: [part("**word", {
      epoch: "old",
      generation: 1,
      version: 1,
      mode: "appendable",
      sourceLength: 6,
    })],
  };
  projection.replace([before]);
  const after = {
    ...message("word"),
    parts: [part("word", {
      epoch: "new",
      generation: 2,
      version: 1,
      mode: "replace",
      sourceLength: 8,
    })],
  };
  projection.replace([after]);
  assertEquals(projection.messages()[0].parts, after.parts);
});
