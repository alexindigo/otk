// SPDX-License-Identifier: LGPL-3.0-only
// Pending-revert draft contract, promoted from INV-T.
import { assertEquals } from "@std/assert";
import {
  createDrafts,
  createSessionRevert,
  createState,
  emptyContent,
  type SessionState,
} from "@otk/client";
import type { ContentSession } from "@otk/protocol";

function fixture() {
  const session = createState<SessionState>({
    selection: { sidecarId: "local", sessionID: "a" },
    latestPrompt: { id: "old-prompt" },
    clock: { epoch: "initial", seq: 0 },
    content: emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  });
  const drafts = createDrafts();
  const base: ContentSession = {
    id: "a",
    title: "A",
    directory: "/project",
    projectID: "p",
    time: { created: 1, updated: 1 },
    archived: false,
  };
  const revert = {
    messageID: "old-prompt",
    messageCount: 1,
    files: [],
    prompt: {
      input: "Recalled old prompt",
      mode: "normal" as const,
      time: 1,
      parts: [{ kind: "text" as const, text: "Recalled old prompt" }],
    },
  };
  let restoreResult: Promise<ContentSession> | undefined;
  const createOwner = () =>
    createSessionRevert({
      session,
      drafts,
      status: { working: () => false, subscribe: () => () => {} },
      actions: {
        abort: () => Promise.resolve(),
        revert: () => Promise.resolve({ ...base, revert }),
        restore: () => restoreResult ?? Promise.resolve(base),
      },
    });
  const owner = createOwner();
  const publish = (staged: boolean) =>
    session.update((state) => {
      state.clock = { epoch: crypto.randomUUID(), seq: 0 };
      state.content.revert = staged ? revert : null;
    });
  const run = async (action: () => Promise<void>, staged: boolean) => {
    const work = action();
    publish(staged);
    await work;
  };
  return {
    session,
    drafts,
    owner,
    createOwner,
    run,
    base,
    holdRestore: (result: Promise<ContentSession>) => {
      restoreResult = result;
    },
  };
}

Deno.test("direct Revert then Restore preserves an untouched full draft", async () => {
  const f = fixture(), write = f.drafts.writer("local/a");
  const before = write((d) => ({
    ...d,
    input: "Unsent work",
    mode: "shell",
    agent: "build",
    model: { provider: "fake", model: "scripted" },
    variant: undefined,
    editor: { text: "Unsaved editor" },
    chips: [{
      id: "image",
      label: "image.png",
      part: {
        kind: "file",
        source: "upload",
        name: "image.png",
        mime: "image/png",
        dataBase64: "YWJj",
      },
    }, {
      id: "mention",
      label: "@build",
      start: 0,
      end: 6,
      part: { kind: "text", text: "Exact mention payload" },
    }],
  }));
  try {
    await f.run(() => f.owner.revertTo("old-prompt"), true);
    await f.run(() => f.owner.restore(), false);
    assertEquals(f.drafts.current("local/a"), before);
  } finally {
    f.owner.dispose();
  }
});

Deno.test("Undo then strip Restore restores the pre-undo draft", async () => {
  const f = fixture(), before = f.drafts.current("local/a");
  try {
    await f.run(() => f.owner.undo(), true);
    assertEquals(f.drafts.current("local/a").input, "Recalled old prompt");
    await f.run(() => f.owner.restore(), false);
    assertEquals(f.drafts.current("local/a"), before);
  } finally {
    f.owner.dispose();
  }
});

Deno.test("Undo then leave-return then Redo retains draft provenance", async () => {
  const f = fixture(), before = f.drafts.current("local/a");
  try {
    await f.run(() => f.owner.undo(), true);
    f.session.update((s) => {
      s.selection = { sidecarId: "local", sessionID: "b" };
    });
    f.session.update((s) => {
      s.selection = { sidecarId: "local", sessionID: "a" };
    });
    await f.run(() => f.owner.redo(), false);
    assertEquals(f.drafts.current("local/a"), before);
  } finally {
    f.owner.dispose();
  }
});

for (const restore of ["restore", "redo"] as const) {
  Deno.test(`${restore} retains both drafts without choosing after a newer edit`, async () => {
    const f = fixture(), write = f.drafts.writer("local/a");
    const before = write((d) => ({ ...d, variant: undefined }));
    try {
      await f.run(() => f.owner.undo(), true);
      const edited = write((d) => ({
        ...d,
        input: "New work",
        editor: { text: "New editor" },
        chips: [{
          id: "new",
          label: "@mention",
          start: 0,
          end: 8,
          part: { kind: "text", text: "Mention payload" },
        }],
      }));
      await f.run(() => f.owner[restore](), false);
      assertEquals(f.drafts.current("local/a"), edited);
      const retained = f.drafts.reverts.get("local/a");
      assertEquals(retained?.before, before);
      assertEquals(Object.hasOwn(retained!.before, "variant"), true);
      assertEquals(retained?.current, edited);
      assertEquals(retained?.edited, true);
    } finally {
      f.owner.dispose();
    }
  });
}

Deno.test("draft transaction keeps the first full snapshot through repeated boundaries", () => {
  const drafts = createDrafts(), write = drafts.writer("local/a");
  const before = write((d) => ({ ...d, input: "  ", variant: undefined }));
  const first = drafts.reverts.capture("local/a");
  first.staged("p2");
  first.recall({ input: "Second", chips: [], mode: "normal" });
  const second = drafts.reverts.capture("local/a", "p2");
  second.staged("p1");
  second.recall({ input: "First", chips: [], mode: "normal" });
  first.staged("p2");
  first.recall({ input: "Late obsolete recall", chips: [], mode: "normal" });
  assertEquals(drafts.current("local/a").input, "First");
  assertEquals(drafts.reverts.restorer("local/a", "p1")(), "restored");
  assertEquals(drafts.current("local/a"), before);
  assertEquals(Object.hasOwn(drafts.current("local/a"), "variant"), true);
  assertEquals(drafts.reverts.get("local/a"), undefined);
});

Deno.test("draft transaction survives replacement of the selected operation owner", async () => {
  const f = fixture(), before = f.drafts.current("local/a");
  await f.run(() => f.owner.undo(), true);
  f.owner.dispose();
  const replacement = f.createOwner();
  try {
    await f.run(() => replacement.restore(), false);
    assertEquals(f.drafts.current("local/a"), before);
  } finally {
    replacement.dispose();
  }
});

for (const edited of [false, true]) {
  Deno.test(`native clear after navigation settles only its captured draft (edited=${edited})`, async () => {
    const f = fixture(), before = f.drafts.current("local/a");
    const held = Promise.withResolvers<ContentSession>();
    try {
      await f.run(() => f.owner.undo(), true);
      f.holdRestore(held.promise);
      const work = f.owner.restore();
      f.session.update((s) => {
        s.selection = { sidecarId: "local", sessionID: "b" };
      });
      if (edited) {
        f.drafts.writer("local/a")((d) => ({ ...d, input: "New work" }));
      }
      held.resolve(f.base);
      await work;
      assertEquals(
        f.drafts.current("local/a"),
        edited ? { ...before, input: "New work" } : before,
      );
      assertEquals(f.drafts.current("local/b").input, "");
    } finally {
      f.owner.dispose();
    }
  });
}

Deno.test("a late native clear cannot consume a replacement draft transaction at the same boundary", () => {
  const drafts = createDrafts(), old = drafts.reverts.capture("one/a");
  old.staged("p");
  old.recall({ input: "Old recalled prompt", chips: [], mode: "normal" });
  const restore = drafts.reverts.restorer("one/a", "p");
  drafts.drop("one/a");
  drafts.writer("one/a")((d) => ({ ...d, input: "New lifetime" }));
  drafts.reverts.capture("one/a").staged("p");
  assertEquals(restore(), "absent");
  assertEquals(drafts.current("one/a").input, "New lifetime");
  assertEquals(drafts.reverts.get("one/a")?.before.input, "New lifetime");
});

Deno.test("draft capture fences empty newer edits, foreign boundaries, servers and dropped lifetimes", () => {
  const drafts = createDrafts(), write = drafts.writer("one/a");
  const capture = drafts.reverts.capture("one/a");
  capture.staged("p");
  write((d) => ({ ...d, input: "" }));
  capture.recall({
    input: "Must not replace newer empty edit",
    chips: [],
    mode: "normal",
  });
  assertEquals(drafts.current("one/a").input, "");
  assertEquals(drafts.reverts.restorer("one/a", "p")(), "edited");
  assertEquals(drafts.reverts.restorer("two/a", "p")(), "absent");
  assertEquals(drafts.reverts.restorer("one/a", "foreign")(), "absent");
  drafts.drop("one/a");
  drafts.writer("one/a")((d) => ({ ...d, input: "Replacement lifetime" }));
  capture.recall({ input: "Retired result", chips: [], mode: "normal" });
  assertEquals(drafts.current("one/a").input, "Replacement lifetime");
  assertEquals(drafts.reverts.get("one/a"), undefined);
});

for (const kind of ["restore", "redo"] as const) {
  for (const ending of ["navigate", "dispose"] as const) {
    for (const mutation of ["none", "edit", "capture"] as const) {
      Deno.test(`confirmed ${kind} settles after reconciliation ${ending} (newer ${mutation})`, async () => {
        const f = fixture();
        const before = f.drafts.writer("local/a")((d) => ({
          ...d,
          agent: "build",
          model: { provider: "fake", model: "scripted" },
          variant: undefined,
        }));
        const held = Promise.withResolvers<ContentSession>();
        try {
          await f.run(() => f.owner.undo(), true);
          assertEquals(
            f.drafts.current("local/a").input,
            "Recalled old prompt",
          );
          f.session.update((s) => {
            s.loading = true;
          });
          f.holdRestore(held.promise);
          const work = f.owner[kind]();
          held.resolve(f.base);
          // The operation registered its await first. Its continuation enters
          // the transcript wait before this same result promise resumes us.
          await held.promise;
          assertEquals(f.owner.state.pending, kind);
          let expected = before;
          if (mutation === "edit") {
            expected = f.drafts.writer("local/a")((d) => ({
              ...d,
              input: "New work",
            }));
          } else if (mutation === "capture") {
            expected = f.drafts.current("local/a");
            f.drafts.reverts.capture("local/a", "old-prompt").staged(
              "old-prompt",
            );
          }
          if (ending === "navigate") {
            f.session.update((s) => {
              s.selection = { sidecarId: "local", sessionID: "b" };
            });
          } else f.owner.dispose();
          await work;
          assertEquals(f.drafts.current("local/a"), expected);
          assertEquals(
            f.drafts.reverts.get("local/a") === undefined,
            mutation === "none",
          );
          assertEquals(f.drafts.current("local/b").input, "");
        } finally {
          f.owner.dispose();
        }
      });
    }
    Deno.test(`rejected ${kind} never restores a draft after ${ending}`, async () => {
      const f = fixture(), held = Promise.withResolvers<ContentSession>();
      try {
        await f.run(() => f.owner.undo(), true);
        const recalled = f.drafts.current("local/a");
        f.session.update((s) => {
          s.loading = true;
        });
        f.holdRestore(held.promise);
        const work = f.owner[kind]();
        if (ending === "navigate") {
          f.session.update((s) => {
            s.selection = { sidecarId: "local", sessionID: "b" };
          });
        } else f.owner.dispose();
        held.reject(new Error("Native clear refused"));
        await work;
        assertEquals(f.drafts.current("local/a"), recalled);
        assertEquals(f.drafts.reverts.get("local/a") !== undefined, true);
      } finally {
        f.owner.dispose();
      }
    });
  }
}
