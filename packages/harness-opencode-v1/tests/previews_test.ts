// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { EXTERNAL_PREVIEW_BYTES, preview } from "../previews.ts";
import { mapTool } from "../map-tools.ts";
import { mapPart } from "../map.ts";
import type { RawPart } from "../types.ts";

Deno.test("external preview reports UTF-8 truncation without splitting a codepoint", () => {
  assertEquals(preview("a😀b", 5), { text: "a😀", truncated: true });
  assertEquals(preview("a😀b", 4), { text: "a", truncated: true });
  assertEquals(preview("a😀b", 6), { text: "a😀b", truncated: false });
  assertEquals(preview({ value: "é" }, 11), {
    text: '{"value":"',
    truncated: true,
  });
  assertEquals(preview(undefined), { text: "", truncated: false });
});

Deno.test("external input metadata unknown parts and output consume the same byte boundary", () => {
  const text = "x".repeat(EXTERNAL_PREVIEW_BYTES - 1) + "😀";
  const part: RawPart = {
    id: "p",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "extension",
    callID: "c",
    state: {
      status: "completed",
      input: { text },
      metadata: { text },
      output: text,
    },
  };
  const call = mapTool(part);
  assert(call.tool === "external");
  assertEquals(call.input, preview(part.state!.input).text);
  assertEquals(call.metadata, preview(part.state!.metadata).text);
  assertEquals(call.output, "x".repeat(EXTERNAL_PREVIEW_BYTES - 1));
  assertEquals(call.outputTruncated, true);
  const unknown = { ...part, type: "extension" };
  const mapped = mapPart(unknown);
  assert(mapped.kind === "external");
  assertEquals(mapped.data, preview(unknown).text);
  part.state!.output = "";
  assertEquals(mapTool(part).output, "");
  part.state!.output = undefined;
  assertEquals(mapTool(part).output, undefined);
});
