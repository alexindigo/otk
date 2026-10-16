// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createDrafts } from "../drafts.ts";
import { createState } from "../state.ts";

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
