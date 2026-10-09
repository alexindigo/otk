// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { promptParts } from "../../sidecar/ws/prompt.ts";
import { mapPromptParts } from "../../sidecar/adapter/opencode1/prompt.ts";
import { editorSave } from "../../web/src/ui/prompt/model.ts";
import { summarizePaste } from "../../web/src/ui/prompt/paste.ts";
import {
  editDraft,
  emptyDraft,
  insertChip,
  serialize,
} from "../../web/src/ui/prompt/model.ts";
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
Deno.test("editor whole-token round trip keeps attachments and paste saves expand changed bytes", () => {
  const upload = insertChip(emptyDraft(), 0, 0, "[Image 1]", {
    kind: "file",
    source: "upload",
    name: "x.png",
    mime: "image/png",
    dataBase64: "AQID",
  });
  const saved = editorSave({
    ...upload,
    editor: { text: "before " + upload.input + " after" },
  });
  assertEquals(saved.chips[0].start, 7);
  assertEquals(serialize(saved)[1], upload.chips[0].part);
  const pasted = insertChip(emptyDraft(), 0, 0, "[Pasted ~3 lines]", {
    kind: "text",
    text: "a\nb\nc",
  });
  const edited = editorSave({
    ...pasted,
    editor: { chipID: pasted.chips[0].id, text: "changed\npaste" },
  });
  assertEquals(serialize(edited), [{ kind: "text", text: "changed\npaste " }]);
  assertEquals(summarizePaste("a\nb\nc", true), true);
  assertEquals(summarizePaste("a".repeat(151), true), true);
  assertEquals(summarizePaste("a\nb\nc", false), false);
});
Deno.test("tracked prompt chips survive surrounding edits and expand only their own text", () => {
  const draft = insertChip(
    { ...emptyDraft(), input: "before after" },
    7,
    7,
    "[Pasted ~3 lines]",
    { kind: "text", text: "one\ntwo\nthree" },
  );
  const next = editDraft(draft, "prefix " + draft.input);
  assertEquals(serialize(next), [{
    kind: "text",
    text: "prefix before one\ntwo\nthree after",
  }]);
  const removed = editDraft(
    next,
    next.input.replace("[Pasted ~3 lines]", "ordinary"),
  );
  assertEquals(removed.chips, []);
});
