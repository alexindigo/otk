// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import * as client from "@otk/client";
import type { Draft, DraftChange } from "@otk/client";
import type { HistoryEntry } from "@otk/protocol";

const entries: HistoryEntry[] = [
  { input: "newest", mode: "normal", time: 2, parts: [] },
  { input: "echo older", mode: "shell", time: 1, parts: [] },
];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const work = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { work, resolve, reject };
}
function consumer(load = () => Promise.resolve(entries)) {
  const drafts = client.createDrafts(), write = drafts.writer("server/session");
  const carets: number[] = [], failures: unknown[] = [];
  let available = true;
  const owner = client.createPromptHistory({
    available: () => available,
    load,
    change: (change: DraftChange, caret?: number) => {
      if (caret !== undefined) carets.push(caret);
      return write(change);
    },
    fail: (error: unknown) => failures.push(error),
  });
  return {
    owner,
    write,
    carets,
    failures,
    unavailable: () => available = false,
  };
}

Deno.test("history recall and return to empty preserve current choices including own undefined Default", async () => {
  for (const variant of ["high", undefined, "absent"] as const) {
    const c = consumer(), model = { provider: "chosen", model: "review" };
    c.write({
      ...client.emptyDraft(),
      agent: "reviewer",
      model,
      ...(variant === "absent" ? {} : { variant }),
    });
    await c.owner.recall(-1);
    let draft = c.write((draft) => draft);
    assertEquals([draft.input, draft.agent, draft.model, draft.variant], [
      "newest",
      "reviewer",
      model,
      variant === "absent" ? undefined : variant,
    ]);
    assertEquals(Object.hasOwn(draft, "variant"), variant !== "absent");
    // Choices made while browsing must also survive the next content change.
    c.write((draft) => ({ ...draft, agent: "planner" }));
    await c.owner.recall(-1);
    draft = c.write((draft) => draft);
    assertEquals([draft.input, draft.mode, draft.agent, draft.model], [
      "echo older",
      "shell",
      "planner",
      model,
    ]);
    await c.owner.recall(1);
    await c.owner.recall(1);
    draft = c.write((draft) => draft);
    assertEquals([
      draft.input,
      draft.mode,
      draft.chips,
      draft.agent,
      draft.model,
    ], ["", "normal", [], "planner", model]);
    assertEquals(Object.hasOwn(draft, "variant"), variant !== "absent");
    assertEquals(c.carets, [0, 0, 6, 0]);
  }
});

Deno.test("history serializes consecutive intents and refuses edited or attached content", async () => {
  const pending = deferred<HistoryEntry[]>(), entered = deferred<void>();
  let reads = 0;
  const c = consumer(() => {
    reads++;
    entered.resolve();
    return pending.work;
  });
  const first = c.owner.recall(-1), second = c.owner.recall(-1);
  await entered.work;
  assertEquals(reads, 1);
  pending.resolve(entries);
  await Promise.all([first, second]);
  assertEquals(c.write((draft) => draft).input, "echo older");
  const edited = c.write((draft) => ({ ...draft, input: "my newer edit" }));
  await c.owner.recall(1);
  assertStrictEquals(c.write((draft) => draft), edited);
  c.owner.reset();
  const attached = c.write(client.attachChip(client.emptyDraft(), "[Image 1]", {
    kind: "file",
    source: "upload",
    mime: "image/png",
    name: "pixel.png",
    dataBase64: "AQID",
  }));
  await c.owner.recall(-1);
  assertStrictEquals(c.write((draft) => draft), attached);
  assertEquals(reads, 1);
});

Deno.test("history joins late loads without replacing edits, reset content or a disposed owner", async () => {
  for (const retire of ["edit", "reset", "dispose", "unavailable"] as const) {
    const pending = deferred<HistoryEntry[]>(), entered = deferred<void>();
    const c = consumer(() => {
      entered.resolve();
      return pending.work;
    });
    const recall = c.owner.recall(-1);
    await entered.work;
    if (retire === "reset") c.owner.reset();
    if (retire === "dispose") c.owner.dispose();
    if (retire === "unavailable") c.unavailable();
    const current = retire === "edit"
      ? c.write((draft) => ({ ...draft, input: "new edit" }))
      : c.write((draft) => draft);
    pending.resolve(entries);
    await recall;
    assertStrictEquals(c.write((draft) => draft), current, retire);
    assertEquals(c.carets, []);
    c.owner.dispose();
    await c.owner.recall(-1);
    assertStrictEquals(c.write((draft) => draft), current);
  }
});

Deno.test("history reports current load failure, recovers its queue and suppresses retired failure", async () => {
  const pending = deferred<HistoryEntry[]>(), entered = deferred<void>();
  let reads = 0;
  const c = consumer(() =>
    ++reads === 1 ? (entered.resolve(), pending.work) : Promise.resolve(entries)
  );
  const recall = c.owner.recall(-1), failure = new Error("history unavailable");
  await entered.work;
  pending.reject(failure);
  await recall;
  assertEquals(c.failures, [failure]);
  await c.owner.recall(-1);
  assertEquals(c.write((draft) => draft).input, "newest");
  const late = deferred<HistoryEntry[]>(), lateEntered = deferred<void>();
  const retired = consumer(() => {
    lateEntered.resolve();
    return late.work;
  });
  const work = retired.owner.recall(-1);
  await lateEntered.work;
  retired.owner.dispose();
  late.reject(new Error("retired"));
  await work;
  assertEquals(retired.failures, []);
});

Deno.test("content replacement, editor save and clear share choice ownership without restoring an editor", () => {
  for (const variant of ["high", undefined, "absent"] as const) {
    const draft: Draft = {
      ...client.emptyDraft(),
      agent: "reviewer",
      model: { provider: "p", model: "m" },
      ...(variant === "absent" ? {} : { variant }),
      editor: { text: "new editor content" },
    };
    for (
      const next of [
        client.replaceDraftContent(draft, {
          input: "recalled",
          mode: "shell",
          chips: [],
        }),
        client.editorSave(draft),
        client.clearDraft(draft),
      ]
    ) {
      assertEquals([
        next.agent,
        next.model,
        next.variant,
        Object.hasOwn(next, "variant"),
        next.editor,
      ], [
        draft.agent,
        draft.model,
        draft.variant,
        Object.hasOwn(draft, "variant"),
        undefined,
      ]);
    }
  }
});

Deno.test("history reads current content and choices while framework publication is deferred", async () => {
  const notifications: (() => void)[] = [];
  const factory: client.StateFactory = <T extends object>(initial: T) => {
    const state = client.createState(initial);
    return {
      ...state,
      update(change: (draft: T) => void) {
        notifications.push(() => state.update(change));
      },
    };
  };
  const drafts = client.createDrafts(factory),
    change = drafts.writer("held/session");
  change({
    ...client.emptyDraft(),
    model: { provider: "p", model: "m" },
    variant: undefined,
  });
  const owner = client.createPromptHistory({
    available: () => true,
    load: () => Promise.resolve(entries),
    change,
    fail(error) {
      throw error;
    },
  });
  await Promise.all([owner.recall(-1), owner.recall(-1)]);
  const current = change((draft) => draft);
  assertEquals([
    current.input,
    current.mode,
    current.model,
    Object.hasOwn(current, "variant"),
  ], ["echo older", "shell", { provider: "p", model: "m" }, true]);
  notifications.splice(0).forEach((publish) => publish());
  assertStrictEquals(drafts.get("held/session"), current);
  owner.dispose();
});
