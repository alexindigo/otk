// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import * as client from "@otk/client";

Deno.test("input guard reads owner-current draft and cancellation preserves editor and attention", () => {
  const drafts = client.createDrafts();
  const draft = {
    ...client.emptyDraft(),
    input: "keep",
    editor: { text: "unsaved" },
    variant: undefined,
  };
  drafts.writer("one")(draft);
  const messages: string[] = [];
  const guard = client.createInputGuard({
    drafts: {
      ...drafts,
      get() {
        throw new Error("painted reads forbidden");
      },
    },
    key: () => "one",
    confirm: (m) => {
      messages.push(m);
      return false;
    },
  });
  guard.mark("permissions", true);
  assertEquals(guard.release(), false);
  assertStrictEquals(drafts.get("one"), draft);
  assertEquals(guard.dirty("permissions"), true);
  assertEquals(messages, [
    "Discard unsaved editor or attention input before switching sessions?",
  ]);
});
Deno.test("input guard confirmation clears only current editor and clear releases only dirty owners", () => {
  const drafts = client.createDrafts();
  let key = "one";
  const value = {
    ...client.emptyDraft(),
    input: "content",
    editor: { text: "edited" },
    variant: undefined,
  };
  drafts.writer("one")(value);
  drafts.writer("two")(value);
  let confirmations = 0;
  const guard = client.createInputGuard({
    drafts,
    key: () => key,
    confirm: () => {
      confirmations++;
      return true;
    },
  });
  key = "two";
  guard.mark("questions", true);
  assertEquals(guard.release(), true);
  assertEquals(drafts.get("two"), { ...value, editor: undefined });
  assertStrictEquals(drafts.get("one"), value);
  assertEquals(Object.hasOwn(drafts.get("two"), "variant"), true);
  assertEquals(guard.dirty("questions"), true);
  guard.clear();
  assertEquals(guard.dirty("questions"), false);
  assertEquals(guard.release(), true);
  assertEquals(confirmations, 1);
});
Deno.test("input guard permit consults only the named owner and does not consume dirty state", () => {
  const messages: string[] = [];
  const guard = client.createInputGuard({
    drafts: client.createDrafts(),
    key: () => "",
    confirm: (m) => {
      messages.push(m);
      return false;
    },
  });
  guard.mark("questions", true);
  assertEquals(guard.permit("permissions", "message"), true);
  guard.mark("permissions", true);
  assertEquals(guard.permit("permissions", "message"), false);
  assertEquals(messages, ["message"]);
  assertEquals(guard.dirty("permissions"), true);
  guard.mark("permissions", false);
  assertEquals(guard.permit("permissions", "message"), true);
});

Deno.test("release asks only when its disposition loses unsent draft content", () => {
  const drafts = client.createDrafts(), messages: string[] = [];
  const draft = { ...client.emptyDraft(), input: "Unsent prompt" };
  drafts.writer("one")(draft);
  const guard = client.createInputGuard({
    drafts,
    key: () => "one",
    confirm: (message) => {
      messages.push(message);
      return false;
    },
  });
  assertEquals(guard.release({ draft: "kept" }), true);
  assertEquals(messages, []);
  assertStrictEquals(drafts.get("one"), draft);
  assertEquals(guard.release({ draft: "dropped" }), false);
  assertEquals(messages.length, 1);
  assertStrictEquals(drafts.get("one"), draft);
  assertEquals(guard.release({ draft: "dropped", keys: ["empty"] }), true);
  assertEquals(messages.length, 1);
  drafts.writer("attachment")({
    ...client.emptyDraft(),
    chips: [{
      id: "file",
      label: "file",
      part: { kind: "file", source: "path", path: "/file" },
    }],
  });
  assertEquals(
    guard.release({ draft: "dropped", keys: ["empty", "attachment"] }),
    false,
  );
  assertEquals(messages.length, 2);
  drafts.writer("attachment")((draft) => ({ ...draft, mode: "shell" }));
  assertEquals(
    guard.release({ draft: "dropped", keys: ["attachment"] }),
    false,
  );
  assertEquals(messages.length, 3);
});
