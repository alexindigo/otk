// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  editDraft,
  editorSave,
  emptyDraft,
  insertChip,
  pasteLabel,
  serialize,
} from "../components/prompt/model.ts";
import { summarizePaste } from "../components/prompt/paste.ts";
Deno.test("paste count labels inflect one long line and multiple lines", () => {
  assertEquals(pasteLabel("x".repeat(200)), "[Pasted ~1 line]");
  assertEquals(pasteLabel("a\nb"), "[Pasted ~2 lines]");
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
