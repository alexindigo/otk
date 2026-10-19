// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  attachChip,
  editDraft,
  editorSave,
  emptyDraft,
  hasDraftContent,
  insertChip,
  pasteLabel,
  removeChip,
  serialize,
} from "../components/prompt/model.ts";
import { summarizePaste } from "../components/prompt/paste.ts";
import { historyDraft, PromptHistory } from "../components/prompt/history.ts";
Deno.test("independent image attachments survive all text and editor edits, serialize once and require explicit removal", () => {
  const part = {
    kind: "file",
    source: "upload",
    name: "sample.png",
    mime: "image/png",
    dataBase64: "AQID",
  } as const;
  const image = attachChip(emptyDraft(), "[Image 1]", part);
  assertEquals(image.input, "");
  assertEquals(hasDraftContent(image), true);
  assertEquals(new PromptHistory().canMove(image), false);
  const edited = editDraft(image, "new text");
  const saved = editorSave({ ...edited, editor: { text: "" } });
  assertEquals(serialize(saved), [{ kind: "text", text: "" }, part]);
  const mixed = insertChip(saved, 0, 0, "[Pasted ~2 lines]", {
    kind: "text",
    text: "one\ntwo",
  });
  assertEquals(serialize(mixed), [{ kind: "text", text: "one\ntwo " }, part]);
  const removed = removeChip(mixed, image.chips[0].id);
  assertEquals(serialize(removed), [{ kind: "text", text: "one\ntwo " }]);
  assertEquals(hasDraftContent(removeChip(image, image.chips[0].id)), false);
});
Deno.test("image history never invents text markers and preserves metadata-only bytes until send", () => {
  const part = {
    kind: "file",
    source: "history",
    name: "sample.png",
    mime: "image/png",
    messageID: "message",
    partID: "part",
    size: 3,
  } as const;
  const recalled = historyDraft({
    input: "inspect",
    mode: "normal",
    time: 1,
    parts: [{ kind: "text", text: "inspect" }, part],
  });
  assertEquals(recalled.input, "inspect");
  assertEquals(recalled.chips[0].start, undefined);
  assertEquals(
    serialize(editorSave({ ...recalled, editor: { text: "new question" } })),
    [{ kind: "text", text: "new question" }, part],
  );
  assertEquals(JSON.stringify(recalled).includes("dataBase64"), false);
  // Authored historical text is data, never stripped as a cosmetic migration.
  const legacy = historyDraft({
    input: "inspect [Image 1]",
    mode: "normal",
    time: 1,
    parts: [part],
  });
  assertEquals(legacy.input, "inspect [Image 1]");
});
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
