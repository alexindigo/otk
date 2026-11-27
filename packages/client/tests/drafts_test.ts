// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createDrafts } from "../drafts.ts";
import { createState } from "../state.ts";
import { serialize } from "../draft-content.ts";
import { prepareAttachments } from "../attachment-batches.ts";
import type { SendOutcome } from "../send-outcome.ts";

Deno.test("committed custody survives until withdrawn or started", () => {
  const drafts = createDrafts();
  const write = drafts.writer("session");
  const draft = write((value) => ({ ...value, input: "Kept until start" }));
  const settle = drafts.captureSend("session", draft).take("send", () => {})!;
  settle({ kind: "committed", messageID: "send" });
  assertEquals(drafts.current("session").input, "");
  settle(
    { kind: "withdrawn", messageID: "send", native: "withdrawn" } as Parameters<
      typeof settle
    >[0],
  );
  assertEquals(drafts.current("session").input, "Kept until start");
  write((value) => ({ ...value, input: "Newer" }));
  settle(
    { kind: "withdrawn", messageID: "send", native: "withdrawn" } as Parameters<
      typeof settle
    >[0],
  );
  assertEquals(drafts.current("session").input, "Newer");
});

Deno.test("a late start does not retire newer input parked by Recover draft", () => {
  const drafts = createDrafts();
  const write = drafts.writer("session");
  const draft = write((value) => ({ ...value, input: "Original" }));
  const settle = drafts.captureSend("session", draft).take("send", () => {})!;
  settle({ kind: "unconfirmed", reason: "Not confirmed", stop: true });
  write((value) => ({ ...value, input: "Newer" }));
  drafts.recoveries("session")[0].run();
  settle({ kind: "started", messageID: "send" });
  assertEquals(drafts.current("session").input, "Original");
  assertEquals(drafts.recoveries("session")[0].draft.input, "Newer");
});

const withdrawn: SendOutcome = {
  kind: "withdrawn",
  messageID: "discard",
  native: "withdrawn",
};

for (
  const [kind, outcome] of [
    ["withdrawn", withdrawn],
    ["stop-unconfirmed", {
      kind: "unconfirmed",
      reason: "No stop result",
      stop: true,
    }],
    ["uncertain", { kind: "unconfirmed", reason: "No send result" }],
  ] as const satisfies readonly (readonly [string, SendOutcome])[]
) {
  Deno.test(`discard ${kind} drops only the chosen kept copy across reload`, () => {
    const drafts = createDrafts();
    const write = drafts.writer("session");
    const edit = (input: string) => write((value) => ({ ...value, input }));
    let checks = 0;
    const settle = drafts.captureSend("session", edit("Discard this copy"))
      .take("discard", () => checks++)!;
    edit("Keep this parked draft");
    settle(outcome);
    const park = drafts.captureSend("session", drafts.current("session"))
      .take("keep", () => {})!;
    edit("Keep typing here");
    park({ ...withdrawn, messageID: "keep" });

    const [discard, keep] = drafts.recoveries("session");
    discard.discard();
    discard.run(); // A stale Recover/Check send action cannot run.
    assertEquals(checks, 0);
    assertEquals(drafts.recoveries("session"), [keep]);
    assertEquals(drafts.current("session").input, "Keep typing here");

    const saved = JSON.stringify(drafts.snapshot());
    assertEquals(saved.includes("Discard this copy"), false);
    const restored = createDrafts();
    restored.restore(JSON.parse(saved));
    if (kind !== "withdrawn") {
      assertEquals(restored.pendingSends().map(({ messageID }) => messageID), [
        "discard",
      ]);
      restored.resumeSend("session", "discard", () => checks++)!(withdrawn);
    }
    assertEquals(restored.pendingSends(), []);
    assertEquals(restored.current("session").input, "Keep typing here");
    assertEquals(
      restored.recoveries("session").map(({ draft }) => draft.input),
      ["Keep this parked draft"],
    );
  });
}

Deno.test("discarding after Recover draft only drops the copy still parked", () => {
  const drafts = createDrafts();
  const write = drafts.writer("session");
  const first = write((draft) => ({ ...draft, input: "Restored to composer" }));
  const settle = drafts.captureSend("session", first).take(
    "discard",
    () => {},
  )!;
  write((draft) => ({ ...draft, input: "Parked by Recover draft" }));
  settle(withdrawn);
  drafts.recoveries("session")[0].run();
  assertEquals(
    drafts.recoveries("session")[0].draft.input,
    "Parked by Recover draft",
  );
  drafts.recoveries("session")[0].discard();
  const restored = createDrafts();
  restored.restore(JSON.parse(JSON.stringify(drafts.snapshot())));
  assertEquals(restored.current("session").input, "Restored to composer");
  assertEquals(restored.recoveries("session"), []);
});

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
