// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createDrafts } from "../drafts.ts";
import { createState } from "../state.ts";
import { serialize } from "../draft-content.ts";
import { prepareAttachments } from "../attachment-batches.ts";

Deno.test("draft writers retain session ownership, attachments and invocation-current identity across delayed painting", () => {
  const queued: (() => void)[] = [];
  const drafts = createDrafts((initial) => {
    const state = createState(initial);
    return {
      ...state,
      update: (change) => {
        queued.push(() => state.update(change));
      },
    };
  });
  const a = drafts.writer("server-a/session"),
    b = drafts.writer("server-b/session");
  const first = a((draft) => ({
    ...draft,
    input: "A",
    agent: "plan",
    chips: [{
      id: "upload",
      start: 0,
      end: 1,
      label: "A",
      pending: true,
      part: { kind: "text", text: "bytes" },
    }],
  }));
  b((draft) => ({ ...draft, input: "B", mode: "shell" }));
  assertStrictEquals(a((draft) => draft), first);
  a((draft) => ({
    ...draft,
    input: draft.input + " edited",
    chips: draft.chips.map((chip) => ({ ...chip, pending: false })),
  }));
  a((current) => current === first ? { ...current, input: "" } : current);
  assertEquals(drafts.get("server-a/session").input, "A edited");
  assertEquals(drafts.get("server-a/session").chips[0].pending, false);
  assertEquals(drafts.get("server-a/session").agent, "plan");
  assertEquals(drafts.get("server-b/session").input, "B");
  assertEquals(drafts.get("server-b/session").mode, "shell");
  queued.forEach((paint) => paint());
  assertEquals(drafts.get("server-a/session").input, "A edited");
});

Deno.test("prompt serialization rebases mention offsets after expanded paste text and keeps recalled bytes", async () => {
  const blank = createDrafts().get("mention-proof");
  const parts = serialize({
    ...blank,
    input: "[Paste] @f",
    chips: [
      {
        id: "paste",
        label: "[Paste]",
        start: 0,
        end: 7,
        part: { kind: "text", text: "longer paste bytes" },
      },
      {
        id: "file",
        label: "@f",
        start: 8,
        end: 10,
        part: {
          kind: "file",
          source: "history",
          name: "original.txt",
          mime: "text/plain",
          size: 4,
          messageID: "message",
          partID: "part",
        },
      },
    ],
  });
  const text = parts[0].kind === "text" ? parts[0].text : "";
  assertEquals(text, "longer paste bytes @f");
  const expected = { start: text.indexOf("@f"), end: text.length, text: "@f" };
  assertEquals(parts[1].mention, expected);
  const prepared = await prepareAttachments(
    parts,
    "local",
    { maxrefs: 2, maxbytes: 100, concurrency: 1 },
    (_server, refs) =>
      Promise.resolve(
        refs.map((ref) => ({
          ref,
          part: {
            kind: "file",
            source: "upload",
            name: "original.txt",
            mime: "text/plain",
            dataBase64: "c2FmZQ==",
          },
        })),
      ),
  );
  assertEquals(prepared[1], {
    kind: "file",
    source: "upload",
    name: "original.txt",
    mime: "text/plain",
    dataBase64: "c2FmZQ==",
    mention: expected,
  });
});
