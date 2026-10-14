// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { promptParts } from "../../core/mod.ts";
import { mapPromptParts } from "@otk/harness-opencode1";
Deno.test("prompt mapping preserves upload bytes and validates sizes and ranges", async () => {
  const parts = promptParts([{ kind: "text", text: "inspect" }, {
    kind: "file",
    source: "upload",
    name: "image.png",
    mime: "image/png",
    dataBase64: "AQID",
  }, { kind: "agent", name: "explore" }]);
  assertEquals(await mapPromptParts(parts, "/unused"), [{
    type: "text",
    text: "inspect",
  }, {
    type: "file",
    filename: "image.png",
    mime: "image/png",
    url: "data:image/png;base64,AQID",
  }, { type: "agent", name: "explore" }]);
  assertThrows(
    () =>
      promptParts([{
        kind: "file",
        source: "upload",
        name: "large",
        mime: "image/png",
        dataBase64: "AAAA".repeat(Math.ceil(20 * 1024 * 1024 / 3) + 1),
      }]),
    Error,
    "20 MiB",
  );
  assertThrows(
    () =>
      promptParts([{
        kind: "file",
        source: "path",
        path: "x",
        range: { start: 20, end: 10 },
      }]),
    Error,
    "range",
  );
  assertThrows(
    () =>
      promptParts([{
        kind: "file",
        source: "upload",
        name: "x",
        mime: "image/png",
        dataBase64: "invalid",
      }]),
    Error,
    "base64",
  );
});
